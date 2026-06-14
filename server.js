// server.js - API dự đoán Tài Xỉu với phân tích MD5 + Cầu
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CẤU HÌNH ==========
const API_URL = 'https://treo-lc79-h6zy.onrender.com/';
const MAX_HISTORY = 100000; // Lưu tối đa 100.000 phiên dự đoán

// ========== LƯU TRỮ DỮ LIỆU ==========
let sessions = [];           // Danh sách phiên từ API (id, result, dice, sum, md5)
let predictions = [];        // Lịch sử dự đoán: { sessionId, predicted, actual, correct, timestamp }

// ========== HÀM PARSE DỮ LIỆU TỪ API GỐC ==========
// API trả về HTML/JSON lồng nhau, cần parse thủ công theo logic cũ
function extractListFromResponse(data) {
    try {
        if (typeof data === 'string') {
            const match = data.match(/\[.*?\]/s);
            if (match) data = JSON.parse(match[0]);
        }
        if (Array.isArray(data)) return data;
        if (data?.data && Array.isArray(data.data)) return data.data;
        if (data?.list && Array.isArray(data.list)) return data.list;
        return [];
    } catch (e) {
        return [];
    }
}

function normalizeSession(item) {
    try {
        // Trường hợp item là string json
        let obj = typeof item === 'string' ? JSON.parse(item) : item;
        if (!obj) return null;

        // Lấy id phiên
        let id = obj.id || obj.session_id || obj.sessionId || '';
        let idNum = parseInt(id.toString().replace(/\D/g, ''));
        if (isNaN(idNum)) return null;

        // Lấy kết quả Tài/Xỉu
        let result = (obj.result || '').toUpperCase();
        if (!result.includes('TAI') && !result.includes('XIU')) {
            if (obj.taiXiu) result = obj.taiXiu === 'TAI' ? 'TAI' : 'XIU';
            else if (obj.status) result = obj.status === 'TAI' ? 'TAI' : 'XIU';
            else return null;
        }
        result = result.includes('TAI') ? 'TAI' : 'XIU';

        // Lấy dice và tổng
        let dice = [];
        let diceSum = 0;
        if (obj.dice && Array.isArray(obj.dice)) dice = obj.dice.slice(0,3);
        else if (obj.xucXac && Array.isArray(obj.xucXac)) dice = obj.xucXac.slice(0,3);
        else if (obj.dice1 && obj.dice2 && obj.dice3) dice = [obj.dice1, obj.dice2, obj.dice3];
        if (dice.length === 3) {
            dice = dice.map(d => parseInt(d));
            diceSum = dice.reduce((a,b)=>a+b,0);
        }

        // Lấy MD5
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
        return null;
    }
}

// ========== THUẬT TOÁN PHÂN TÍCH ==========
// 1. Phân tích MD5: tìm các phiên có MD5 tương tự (so khớp 80% độ dài)
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

// 2. Phân tích cầu (pattern chuỗi kết quả)
function analyzePattern(results) {
    if (results.length < 3) return { prediction: null, confidence: 0, reason: 'Chưa đủ dữ liệu' };
    // Lấy 10 kết quả gần nhất
    const recent = results.slice(0, 12).map(r => r.result);
    const last = recent[0];
    // Đếm bệt
    let streak = 1;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] === last) streak++;
        else break;
    }
    // Phát hiện cầu đảo (pingpong)
    let pingpongLen = 1;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] !== recent[i-1]) pingpongLen++;
        else break;
    }
    // Tỷ lệ Tài/Xỉu gần đây
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
        // Cầu đảo: dự đoán ngược lại phiên cuối
        prediction = last === 'TAI' ? 'XIU' : 'TAI';
        confidence = 65;
        reason = `Cầu đảo ${pingpongLen} phiên`;
    } else {
        // Dựa vào tỷ lệ gần nhất
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

// 3. Kết hợp MD5 và cầu -> dự đoán cuối cùng
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
            // Ưu tiên MD5 nếu độ tin cậy cao hơn nhiều
            if (md5Pred.confidence >= patternPred.confidence + 15) {
                finalPred = md5Pred.prediction;
                finalConf = md5Pred.confidence;
                method = 'MD5 (ưu thế)';
            } else if (patternPred.confidence >= md5Pred.confidence + 15) {
                finalPred = patternPred.prediction;
                finalConf = patternPred.confidence;
                method = 'Cầu (ưu thế)';
            } else {
                // Mâu thuẫn, chọn theo xu hướng dài hạn
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

// ========== CẬP NHẬT DỮ LIỆU & DỰ ĐOÁN ==========
async function fetchAndUpdate() {
    try {
        const resp = await axios.get(API_URL, { timeout: 15000 });
        const rawList = extractListFromResponse(resp.data);
        if (!rawList.length) return false;

        const newSessions = rawList.map(normalizeSession).filter(Boolean);
        if (!newSessions.length) return false;

        // Sắp xếp giảm dần theo id_num (mới nhất đầu)
        newSessions.sort((a,b) => b.id_num - a.id_num);
        
        // Hợp nhất với sessions cũ (giữ id duy nhất)
        const existingIds = new Set(sessions.map(s => s.id));
        const added = [];
        for (const ns of newSessions) {
            if (!existingIds.has(ns.id)) {
                sessions.unshift(ns); // thêm vào đầu
                added.push(ns);
            }
        }
        // Giới hạn số lượng sessions
        if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
        
        // Với mỗi phiên mới được thêm, kiểm tra xem trước đó có dự đoán cho phiên này không
        for (const sess of added) {
            const existingPred = predictions.find(p => p.sessionId === sess.id);
            if (existingPred && existingPred.correct === null) {
                existingPred.actual = sess.result;
                existingPred.correct = (existingPred.predicted === sess.result);
                existingPred.timestamp = Date.now();
            }
        }
        
        // Dự đoán cho phiên tiếp theo (dựa trên sessions hiện tại)
        if (sessions.length === 0) return false;
        
        const latest = sessions[0];
        const nextIdNum = latest.id_num + 1;
        
        // Lấy lịch sử kết quả (chỉ lấy các phiên cũ hơn phiên mới nhất)
        const historyResults = sessions.slice(1).map(s => ({ result: s.result, md5: s.md5 }));
        
        // Phân tích MD5 dựa trên MD5 của phiên mới nhất
        const md5Analysis = analyzeMd5(latest.md5, sessions.slice(1));
        // Phân tích cầu
        const patternAnalysis = analyzePattern(sessions);
        
        const combined = combinePredictions(md5Analysis, patternAnalysis);
        
        // Lưu dự đoán cho phiên tiếp theo (sẽ update sau khi có kết quả thực)
        predictions.unshift({
            sessionId: null, // chưa biết id thực
            predictedId: nextIdNum,
            predicted: combined.prediction,
            confidence: combined.confidence,
            method: combined.method,
            actual: null,
            correct: null,
            timestamp: Date.now()
        });
        if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
        
        return true;
    } catch (err) {
        console.error('Fetch error:', err.message);
        return false;
    }
}

// Tự động cập nhật mỗi 30 giây
setInterval(async () => {
    await fetchAndUpdate();
}, 30000);

// Khởi tạo lần đầu
fetchAndUpdate();

// ========== API ENDPOINTS ==========
app.use(express.json());

// Endpoint lấy dự đoán hiện tại + thống kê
app.get('/predict', async (req, res) => {
    // Force cập nhật ngay khi có request (tuỳ chọn)
    await fetchAndUpdate();
    
    if (sessions.length === 0) {
        return res.json({ error: 'Chưa có dữ liệu từ API gốc' });
    }
    
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId) || null;
    
    // Thống kê tổng hợp dự đoán đã có kết quả
    const completed = predictions.filter(p => p.correct !== null);
    const totalCompleted = completed.length;
    const correctCount = completed.filter(p => p.correct === true).length;
    const wrongCount = totalCompleted - correctCount;
    const accuracy = totalCompleted > 0 ? (correctCount / totalCompleted * 100).toFixed(1) : '0';
    
    // Lấy 20 dự đoán gần nhất kèm đánh giá
    const recentPredictions = predictions.slice(0, 20).map(p => ({
        phiên: p.predictedId,
        dự_đoán: p.predicted === 'TAI' ? 'Tài' : 'Xỉu',
        độ_tin_cậy: p.confidence,
        phương_pháp: p.method,
        kết_quả_thực: p.actual ? (p.actual === 'TAI' ? 'Tài' : 'Xỉu') : 'Chưa có',
        đánh_giá: p.correct === null ? 'Đang chờ' : (p.correct ? '✅ Đúng' : '❌ Sai')
    }));
    
    res.json({
        status: 'success',
        timestamp: new Date().toISOString(),
        phiên_hiện_tại: {
            id: latest.id,
            id_số: latest.id_num,
            kết_quả: latest.result === 'TAI' ? 'Tài' : 'Xỉu',
            xúc_xắc: latest.dice,
            tổng: latest.diceSum,
            md5: latest.md5
        },
        dự_đoán_phiên_tiếp: {
            id_dự_đoán: nextId,
            dự_đoán: lastPrediction ? (lastPrediction.predicted === 'TAI' ? 'Tài' : 'Xỉu') : 'Không có',
            độ_tin_cậy: lastPrediction ? lastPrediction.confidence : 0,
            phương_pháp: lastPrediction ? lastPrediction.method : 'Chưa đủ dữ liệu'
        },
        thống_kê_dự_đoán: {
            tổng_số_phiên_đã_đánh_giá: totalCompleted,
            đúng: correctCount,
            sai: wrongCount,
            tỷ_lệ_đúng: `${accuracy}%`,
            lịch_sử_gần_đây: recentPredictions
        },
        thông_tin: {
            tổng_phiên_api: sessions.length,
            giới_hạn_tối_đa: MAX_HISTORY
        }
    });
});

// Endpoint lấy lịch sử đầy đủ (có phân trang)
app.get('/history', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const start = (page - 1) * limit;
    const end = start + limit;
    
    const historyData = predictions.map(p => ({
        phiên: p.predictedId,
        dự_đoán: p.predicted === 'TAI' ? 'Tài' : 'Xỉu',
        độ_tin_cậy: p.confidence,
        kết_quả_thực: p.actual ? (p.actual === 'TAI' ? 'Tài' : 'Xỉu') : null,
        đúng_sai: p.correct === null ? null : (p.correct ? true : false),
        thời_gian: new Date(p.timestamp).toISOString()
    }));
    
    res.json({
        total: predictions.length,
        page,
        limit,
        data: historyData.slice(start, end)
    });
});

// Endpoint health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.length, predictions: predictions.length });
});

// Khởi động server
app.listen(PORT, () => {
    console.log(`🚀 API dự đoán chạy tại http://localhost:${PORT}`);
    console.log(`📡 Endpoint chính: /predict`);
    console.log(`📜 Lịch sử: /history?page=1&limit=50`);
});