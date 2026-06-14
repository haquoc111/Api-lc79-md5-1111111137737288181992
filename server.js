const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CẤU HÌNH ==========
const API_URL = 'https://treo-lc79-h6zy.onrender.com/';
const MAX_HISTORY = 100000;
const FETCH_INTERVAL = 30000; // 30 giây

// ========== LƯU TRỮ ==========
let sessions = [];      // [{ id, id_num, result, dice, diceSum, md5 }]
let predictions = [];   // [{ predictedId, predicted, confidence, method, actual, correct, timestamp }]
let lastFetchError = null;
let isFetching = false;

// ========== HÀM PARSE (cải tiến, in log để debug) ==========
function extractListFromResponse(data) {
    try {
        // Nếu là string, thử parse JSON
        if (typeof data === 'string') {
            // Thử tìm mảng JSON trong chuỗi
            const jsonMatch = data.match(/\[\s*\{.*\}\s*\]/s);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            // Thử parse toàn bộ
            try {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) return parsed;
                if (parsed?.data && Array.isArray(parsed.data)) return parsed.data;
                if (parsed?.list && Array.isArray(parsed.list)) return parsed.list;
            } catch(e) {}
        }
        if (Array.isArray(data)) return data;
        if (data?.data && Array.isArray(data.data)) return data.data;
        if (data?.list && Array.isArray(data.list)) return data.list;
        return [];
    } catch (e) {
        console.error('extractListFromResponse error:', e.message);
        return [];
    }
}

function normalizeSession(item) {
    try {
        let obj = typeof item === 'string' ? JSON.parse(item) : item;
        if (!obj) return null;

        // Lấy id
        let id = obj.id || obj.session_id || obj.sessionId || '';
        let idNum = parseInt(id.toString().replace(/\D/g, ''));
        if (isNaN(idNum)) return null;

        // Kết quả
        let result = (obj.result || '').toUpperCase();
        if (!result.includes('TAI') && !result.includes('XIU')) {
            if (obj.taiXiu) result = obj.taiXiu === 'TAI' ? 'TAI' : 'XIU';
            else if (obj.status) result = obj.status === 'TAI' ? 'TAI' : 'XIU';
            else return null;
        }
        result = result.includes('TAI') ? 'TAI' : 'XIU';

        // Xúc xắc
        let dice = [];
        let diceSum = 0;
        if (obj.dice && Array.isArray(obj.dice)) dice = obj.dice.slice(0,3);
        else if (obj.xucXac && Array.isArray(obj.xucXac)) dice = obj.xucXac.slice(0,3);
        else if (obj.dice1 && obj.dice2 && obj.dice3) dice = [obj.dice1, obj.dice2, obj.dice3];
        if (dice.length === 3) {
            dice = dice.map(d => parseInt(d));
            diceSum = dice.reduce((a,b)=>a+b,0);
        } else {
            // Nếu không có dice, thử tính từ tổng? Bỏ qua
        }

        let md5 = obj.md5 || obj.hash || '';

        return {
            id: String(id),
            id_num: idNum,
            result,
            dice,
            diceSum,
            md5: md5.replace(/\s/g, '')
        };
    } catch (e) {
        console.error('normalizeSession error:', e.message);
        return null;
    }
}

// ========== THUẬT TOÁN PHÂN TÍCH ==========
function findSimilarMd5(currentMd5, history) {
    if (!currentMd5 || currentMd5.length < 10) return [];
    const similar = [];
    for (const s of history) {
        if (!s.md5 || s.md5 === currentMd5) continue;
        let matchCount = 0;
        const minLen = Math.min(currentMd5.length, s.md5.length);
        for (let i = 0; i < minLen; i++) {
            if (currentMd5[i] === s.md5[i]) matchCount++;
        }
        const ratio = matchCount / minLen;
        if (ratio >= 0.7) {
            similar.push({ session: s, ratio });
        }
    }
    similar.sort((a,b) => b.ratio - a.ratio);
    return similar.slice(0, 20);
}

function analyzeMd5(currentMd5, history) {
    const similar = findSimilarMd5(currentMd5, history);
    if (similar.length === 0) return { prediction: null, confidence: 0, samples: 0 };
    let taiCount = 0, xiuCount = 0;
    for (const item of similar) {
        if (item.session.result === 'TAI') taiCount++;
        else xiuCount++;
    }
    const total = taiCount + xiuCount;
    const pred = taiCount > xiuCount ? 'TAI' : 'XIU';
    const conf = Math.round((Math.max(taiCount, xiuCount) / total) * 100);
    return { prediction: pred, confidence: conf, samples: total };
}

function analyzePattern(results) {
    if (results.length < 3) return { prediction: null, confidence: 0, reason: 'Chưa đủ dữ liệu' };
    const recent = results.slice(0, 12).map(r => r.result);
    const last = recent[0];
    let streak = 1;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] === last) streak++;
        else break;
    }
    let pingpongLen = 1;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] !== recent[i-1]) pingpongLen++;
        else break;
    }
    const taiCount = recent.filter(r => r === 'TAI').length;
    const xiuCount = recent.length - taiCount;
    const taiRate = (taiCount / recent.length) * 100;

    let prediction = null;
    let confidence = 0;
    let reason = '';

    if (streak >= 3) {
        prediction = last;
        confidence = 60 + Math.min(streak * 5, 30);
        reason = `Bệt ${streak} phiên ${last === 'TAI' ? 'TÀI' : 'XỈU'}`;
    } else if (pingpongLen >= 3) {
        prediction = last === 'TAI' ? 'XIU' : 'TAI';
        confidence = 65;
        reason = `Cầu đảo ${pingpongLen} phiên`;
    } else {
        if (taiRate >= 65) {
            prediction = 'TAI';
            confidence = Math.round(taiRate);
            reason = `Tài chiếm ${Math.round(taiRate)}% 12 phiên gần nhất`;
        } else if (xiuCount / recent.length >= 0.65) {
            prediction = 'XIU';
            confidence = Math.round((xiuCount / recent.length) * 100);
            reason = `Xỉu chiếm ${Math.round((xiuCount / recent.length)*100)}% 12 phiên gần nhất`;
        } else {
            prediction = null;
            confidence = 0;
            reason = 'Không đủ pattern rõ ràng';
        }
    }
    return { prediction, confidence, reason, streak, pingpongLen, taiRate };
}

function combinePredictions(md5Pred, patternPred) {
    let finalPred = null;
    let finalConf = 0;
    let method = '';

    if (md5Pred.prediction && patternPred.prediction) {
        if (md5Pred.prediction === patternPred.prediction) {
            finalPred = md5Pred.prediction;
            finalConf = Math.min(Math.round((md5Pred.confidence + patternPred.confidence) / 2), 95);
            method = 'MD5 + Cầu đồng thuận';
        } else {
            if (md5Pred.confidence >= patternPred.confidence + 15) {
                finalPred = md5Pred.prediction;
                finalConf = md5Pred.confidence;
                method = 'MD5 (ưu thế)';
            } else if (patternPred.confidence >= md5Pred.confidence + 15) {
                finalPred = patternPred.prediction;
                finalConf = patternPred.confidence;
                method = 'Cầu (ưu thế)';
            } else {
                const taiCount = sessions.filter(s => s.result === 'TAI').length;
                const xiuCount = sessions.length - taiCount;
                finalPred = taiCount > xiuCount ? 'TAI' : 'XIU';
                finalConf = 55;
                method = 'Mâu thuẫn → chọn theo tổng thể';
            }
        }
    } else if (md5Pred.prediction) {
        finalPred = md5Pred.prediction;
        finalConf = md5Pred.confidence;
        method = 'Chỉ MD5';
    } else if (patternPred.prediction) {
        finalPred = patternPred.prediction;
        finalConf = patternPred.confidence;
        method = 'Chỉ cầu';
    }
    return { prediction: finalPred, confidence: finalConf, method };
}

// ========== CẬP NHẬT DỮ LIỆU ==========
async function fetchAndUpdate() {
    if (isFetching) return false;
    isFetching = true;
    try {
        console.log(`[${new Date().toISOString()}] Fetching data from API...`);
        const resp = await axios.get(API_URL, {
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*'
            }
        });
        console.log(`Response status: ${resp.status}, content-type: ${resp.headers['content-type']}`);
        
        const rawList = extractListFromResponse(resp.data);
        if (!rawList.length) {
            console.warn('Extracted list is empty. Sample data:', typeof resp.data === 'string' ? resp.data.slice(0, 200) : resp.data);
            lastFetchError = 'API trả về danh sách rỗng';
            isFetching = false;
            return false;
        }
        
        const newSessions = rawList.map(normalizeSession).filter(Boolean);
        if (!newSessions.length) {
            console.warn('No valid sessions after normalization');
            lastFetchError = 'Không có phiên hợp lệ sau khi parse';
            isFetching = false;
            return false;
        }
        
        // Sắp xếp mới nhất lên đầu
        newSessions.sort((a,b) => b.id_num - a.id_num);
        
        // Hợp nhất với sessions cũ (giữ id duy nhất)
        const existingIds = new Set(sessions.map(s => s.id));
        let addedCount = 0;
        for (const ns of newSessions) {
            if (!existingIds.has(ns.id)) {
                sessions.unshift(ns);
                addedCount++;
                existingIds.add(ns.id);
            }
        }
        if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
        console.log(`Added ${addedCount} new sessions. Total: ${sessions.length}`);
        
        // Cập nhật kết quả thực cho các dự đoán trước
        for (const sess of newSessions) {
            const existingPred = predictions.find(p => p.predictedId === sess.id_num);
            if (existingPred && existingPred.correct === null) {
                existingPred.actual = sess.result;
                existingPred.correct = (existingPred.predicted === sess.result);
                existingPred.timestamp = Date.now();
                console.log(`Updated prediction for session ${sess.id_num}: ${existingPred.correct ? 'Correct' : 'Wrong'}`);
            }
        }
        
        // Dự đoán cho phiên tiếp theo
        if (sessions.length === 0) {
            isFetching = false;
            return false;
        }
        const latest = sessions[0];
        const nextIdNum = latest.id_num + 1;
        
        const historyResults = sessions.slice(1);
        const md5Analysis = analyzeMd5(latest.md5, historyResults);
        const patternAnalysis = analyzePattern(sessions);
        const combined = combinePredictions(md5Analysis, patternAnalysis);
        
        if (combined.prediction) {
            predictions.unshift({
                predictedId: nextIdNum,
                predicted: combined.prediction,
                confidence: combined.confidence,
                method: combined.method,
                actual: null,
                correct: null,
                timestamp: Date.now()
            });
            if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
            console.log(`New prediction for session #${nextIdNum}: ${combined.prediction} (${combined.confidence}%)`);
        }
        
        lastFetchError = null;
        isFetching = false;
        return true;
    } catch (err) {
        console.error('Fetch error:', err.message);
        lastFetchError = err.message;
        isFetching = false;
        return false;
    }
}

// Khởi động fetch lần đầu và theo chu kỳ
setInterval(() => fetchAndUpdate(), FETCH_INTERVAL);
fetchAndUpdate(); // chạy ngay

// ========== API ENDPOINTS ==========
app.use(express.json());

// Endpoint trả về text theo mẫu yêu cầu
app.get('/predict_text', async (req, res) => {
    // Đợi fetch lần đầu nếu chưa có dữ liệu
    if (sessions.length === 0 && !lastFetchError) {
        await fetchAndUpdate();
    }
    if (sessions.length === 0) {
        let errorMsg = '❌ Chưa có dữ liệu từ API gốc.\n';
        if (lastFetchError) errorMsg += `Lỗi gần nhất: ${lastFetchError}\n`;
        errorMsg += `API URL: ${API_URL}\nHãy kiểm tra kết nối hoặc thử lại sau.`;
        return res.status(503).send(errorMsg);
    }
    
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId);
    
    // Tạo phần "Thuật toán dự đoán": lấy tất cả phiên (tối đa 100 phiên gần nhất để tránh quá dài)
    let thuatToan = '📜 **LỊCH SỬ CÁC PHIÊN (KẾT QUẢ THỰC TẾ)**\n';
    thuatToan += '| Phiên | Kết quả | Xúc xắc |\n';
    thuatToan += '|-------|---------|---------|\n';
    const maxDisplay = Math.min(sessions.length, 100);
    for (let i = 0; i < maxDisplay; i++) {
        const s = sessions[i];
        const diceStr = s.dice.length ? s.dice.join('-') : '?';
        thuatToan += `| ${s.id_num} | ${s.result === 'TAI' ? 'Tài' : 'Xỉu'} | ${diceStr} |\n`;
    }
    if (sessions.length > 100) {
        thuatToan += `| ... và ${sessions.length - 100} phiên cũ hơn | ... | ... |\n`;
    }
    
    // Thống kê dự đoán
    let thongKe = '\n📊 **THỐNG KÊ DỰ ĐOÁN**\n';
    thongKe += '| Phiên | KQ thực | Dự đoán | Đánh giá |\n';
    thongKe += '|-------|---------|---------|----------|\n';
    const completed = predictions.filter(p => p.correct !== null).slice(0, 30);
    for (const p of completed.reverse()) {
        const actual = p.actual === 'TAI' ? 'Tài' : 'Xỉu';
        const pred = p.predicted === 'TAI' ? 'Tài' : 'Xỉu';
        const danhGia = p.correct ? '✅ Đúng' : '❌ Sai';
        thongKe += `| ${p.predictedId} | ${actual} | ${pred} | ${danhGia} |\n`;
    }
    const totalCompleted = predictions.filter(p => p.correct !== null).length;
    const correctCount = predictions.filter(p => p.correct === true).length;
    const accuracy = totalCompleted > 0 ? (correctCount / totalCompleted * 100).toFixed(1) : '0';
    thongKe += `\n📈 Tổng số phiên đã đánh giá: ${totalCompleted}\n`;
    thongKe += `✅ Đúng: ${correctCount}   ❌ Sai: ${totalCompleted - correctCount}\n`;
    thongKe += `🎯 Tỷ lệ chính xác: ${accuracy}%\n`;
    
    // Kết luận dự đoán
    let chot = lastPrediction ? (lastPrediction.predicted === 'TAI' ? 'Tài' : 'Xỉu') : 'Chưa có';
    let doTinCay = lastPrediction ? lastPrediction.confidence : 0;
    
    const resultText = `🔮 **DỰ ĐOÁN PHIÊN TIẾP THEO** 🔮
━━━━━━━━━━━━━━━━━━━━
📌 **Phiên hiện tại:** #${latest.id_num}
🎲 Xúc xắc: ${latest.dice.join('-')} (Tổng ${latest.diceSum})
🏆 Kết quả: ${latest.result === 'TAI' ? 'Tài 🔴' : 'Xỉu ⚪'}

${thuatToan}
━━━━━━━━━━━━━━━━━━━━
✨ **CHỐT DỰ ĐOÁN PHIÊN #${nextId}:**  
👉 **${chot}**  
🔒 Độ tin cậy: **${doTinCay}%**  
🧠 Phương pháp: ${lastPrediction ? lastPrediction.method : 'Chưa có'}

${thongKe}
━━━━━━━━━━━━━━━━━━━━
⏱ Cập nhật: ${new Date().toLocaleString('vi-VN')}
🔄 Tự động làm mới mỗi 30 giây
📱 API: /predict_text (text)  |  /predict (JSON)`;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(resultText);
});

// Endpoint JSON
app.get('/predict', async (req, res) => {
    if (sessions.length === 0) {
        return res.status(503).json({ error: 'Chưa có dữ liệu từ API gốc', details: lastFetchError });
    }
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId);
    
    const completed = predictions.filter(p => p.correct !== null);
    const correctCount = completed.filter(p => p.correct === true).length;
    const totalCompleted = completed.length;
    const accuracy = totalCompleted > 0 ? (correctCount / totalCompleted * 100).toFixed(1) : '0';
    
    const recentPredictions = predictions.slice(0, 30).map(p => ({
        phiên: p.predictedId,
        kq_thuc: p.actual ? (p.actual === 'TAI' ? 'Tài' : 'Xỉu') : null,
        du_doan: p.predicted === 'TAI' ? 'Tài' : 'Xỉu',
        danh_gia: p.correct === null ? 'Chờ' : (p.correct ? 'Đúng' : 'Sai')
    }));
    
    res.json({
        status: 'success',
        timestamp: new Date().toISOString(),
        phien_hien_tai: {
            id: latest.id_num,
            ket_qua: latest.result === 'TAI' ? 'Tài' : 'Xỉu',
            xuc_xac: latest.dice.join('-'),
            tong: latest.diceSum
        },
        du_doan_phien_tiep: {
            phien: nextId,
            chot: lastPrediction ? (lastPrediction.predicted === 'TAI' ? 'Tài' : 'Xỉu') : null,
            do_tin_cay: lastPrediction ? lastPrediction.confidence : 0,
            phuong_phap: lastPrediction ? lastPrediction.method : null
        },
        thong_ke_du_doan: {
            tong_phiên_da_danh_gia: totalCompleted,
            dung: correctCount,
            sai: totalCompleted - correctCount,
            ty_le_dung: `${accuracy}%`,
            lich_su_gan_day: recentPredictions
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: sessions.length > 0 ? 'ok' : 'initializing',
        sessions: sessions.length,
        predictions: predictions.length,
        lastError: lastFetchError
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API dự đoán chạy tại http://localhost:${PORT}`);
    console.log(`📝 Xem báo cáo dạng text: http://localhost:${PORT}/predict_text`);
    console.log(`📊 Xem JSON: http://localhost:${PORT}/predict`);
    console.log(`🔍 Health check: http://localhost:${PORT}/health`);
});