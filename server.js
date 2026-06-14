// server.js - API dự đoán Tài Xỉu với phân tích MD5 + cầu (fix lỗi parse)
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = 'https://treo-lc79-h6zy.onrender.com/';
const MAX_HISTORY = 100000;
const FETCH_INTERVAL = 30000;
const CACHE_FILE = path.join(__dirname, 'sessions_cache.json');

let sessions = [];
let predictions = [];
let usingMock = false;
let lastFetchError = null;
let isFetching = false;

// ========== CACHE ==========
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            if (data.sessions) sessions = data.sessions;
            if (data.predictions) predictions = data.predictions;
            console.log(`Loaded cache: ${sessions.length} sessions, ${predictions.length} predictions`);
        }
    } catch(e) { console.error('Load cache error:', e.message); }
}
function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ sessions, predictions }, null, 2));
    } catch(e) { console.error('Save cache error:', e.message); }
}

// ========== MOCK DATA ==========
function generateMockSessions() {
    const mock = [];
    for (let i = 0; i < 50; i++) {
        const idNum = 1000000 + i;
        const result = Math.random() > 0.5 ? 'TAI' : 'XIU';
        const dice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
        const diceSum = dice.reduce((a,b)=>a+b,0);
        const md5 = `mock_${idNum}_${Math.random().toString(36).substring(2,10)}`;
        mock.push({ id: String(idNum), id_num: idNum, result, dice, diceSum, md5 });
    }
    mock.sort((a,b) => b.id_num - a.id_num);
    return mock;
}

// ========== PARSE DỮ LIỆU TỪ API GỐC (linh hoạt, có log) ==========
function tryParseSessions(rawData) {
    let list = [];
    console.log('Raw data type:', typeof rawData);
    if (typeof rawData === 'string') {
        console.log('Raw string preview:', rawData.slice(0, 500));
        // Tìm mảng JSON trong chuỗi
        const arrayMatch = rawData.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (arrayMatch) {
            try { list = JSON.parse(arrayMatch[0]); console.log('Found JSON array, length:', list.length); } catch(e) {}
        }
        if (!list.length) {
            try { list = JSON.parse(rawData); console.log('Parsed whole string as JSON, isArray:', Array.isArray(list)); } catch(e) {}
        }
    } else if (Array.isArray(rawData)) {
        list = rawData;
        console.log('Input is array, length:', list.length);
    } else if (rawData && typeof rawData === 'object') {
        console.log('Input object keys:', Object.keys(rawData));
        for (const key of ['data', 'list', 'result', 'sessions', 'items', 'history', 'dice_results']) {
            if (Array.isArray(rawData[key])) {
                list = rawData[key];
                console.log(`Found array at key "${key}", length: ${list.length}`);
                break;
            }
        }
        if (!list.length && Object.values(rawData).some(v => Array.isArray(v))) {
            const arr = Object.values(rawData).find(v => Array.isArray(v));
            if (arr) { list = arr; console.log('Found array in object values, length:', list.length); }
        }
    }
    
    const parsed = [];
    for (const item of list) {
        try {
            let obj = typeof item === 'string' ? JSON.parse(item) : item;
            if (!obj) continue;
            let id = obj.id || obj.session_id || obj.sessionId || '';
            let idNum = parseInt(id.toString().replace(/\D/g, ''));
            if (isNaN(idNum)) continue;
            let result = (obj.result || obj.taiXiu || obj.status || '').toUpperCase();
            if (result.includes('TAI')) result = 'TAI';
            else if (result.includes('XIU')) result = 'XIU';
            else continue;
            
            // Parse dice: thử nhiều dạng
            let dice = [];
            if (obj.dice && Array.isArray(obj.dice)) dice = obj.dice.slice(0,3);
            else if (obj.xucXac && Array.isArray(obj.xucXac)) dice = obj.xucXac.slice(0,3);
            else if (obj.dice1 && obj.dice2 && obj.dice3) dice = [obj.dice1, obj.dice2, obj.dice3];
            else if (obj.dice_result && Array.isArray(obj.dice_result)) dice = obj.dice_result.slice(0,3);
            else if (obj.dice_value && Array.isArray(obj.dice_value)) dice = obj.dice_value.slice(0,3);
            else if (obj.values && Array.isArray(obj.values)) dice = obj.values.slice(0,3);
            if (dice.length !== 3) dice = [0,0,0];
            else dice = dice.map(d => parseInt(d));
            const diceSum = dice.reduce((a,b)=>a+b,0);
            const md5 = (obj.md5 || obj.hash || '').replace(/\s/g, '');
            parsed.push({ id: String(id), id_num: idNum, result, dice, diceSum, md5 });
        } catch(e) { console.log('Item parse error:', e.message); }
    }
    console.log(`Parsed ${parsed.length} valid sessions.`);
    if (parsed.length > 0) console.log('First session sample:', JSON.stringify(parsed[0]));
    return parsed;
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
        if (ratio >= 0.7) similar.push({ session: s, ratio });
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

function updatePredictions() {
    if (sessions.length === 0) return;
    const latest = sessions[0];
    const nextIdNum = latest.id_num + 1;
    const historyResults = sessions.slice(1);
    const md5Analysis = analyzeMd5(latest.md5, historyResults);
    const patternAnalysis = analyzePattern(sessions);
    const combined = combinePredictions(md5Analysis, patternAnalysis);
    if (combined.prediction) {
        const existing = predictions.find(p => p.predictedId === nextIdNum);
        if (!existing) {
            predictions.unshift({
                predictedId: nextIdNum,
                predicted: combined.prediction,
                confidence: combined.confidence,
                method: combined.method,
                actual: null,
                correct: null,
                timestamp: Date.now()
            });
        } else if (existing.correct === null) {
            existing.predicted = combined.prediction;
            existing.confidence = combined.confidence;
            existing.method = combined.method;
        }
        if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
        saveCache();
        console.log(`Updated prediction for #${nextIdNum}: ${combined.prediction} (${combined.confidence}%)`);
    } else {
        console.log('No valid prediction generated.');
    }
}

// ========== FETCH DỮ LIỆU THẬT ==========
async function fetchRealData() {
    if (isFetching) return false;
    isFetching = true;
    try {
        console.log(`[${new Date().toISOString()}] Fetching from ${API_URL}...`);
        const resp = await axios.get(API_URL, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const parsedSessions = tryParseSessions(resp.data);
        if (parsedSessions.length === 0) {
            lastFetchError = 'API trả về nhưng không parse được phiên nào';
            isFetching = false;
            return false;
        }
        const existingIds = new Set(sessions.map(s => s.id));
        let added = 0;
        for (const ns of parsedSessions) {
            if (!existingIds.has(ns.id)) {
                sessions.push(ns);
                added++;
            }
        }
        sessions.sort((a,b) => b.id_num - a.id_num);
        if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
        console.log(`Added ${added} new sessions. Total: ${sessions.length}`);
        // Cập nhật kết quả cho dự đoán cũ
        for (const sess of parsedSessions) {
            const pred = predictions.find(p => p.predictedId === sess.id_num);
            if (pred && pred.correct === null) {
                pred.actual = sess.result;
                pred.correct = (pred.predicted === sess.result);
                console.log(`Prediction for #${sess.id_num}: ${pred.correct ? 'Đúng' : 'Sai'}`);
            }
        }
        usingMock = false;
        lastFetchError = null;
        updatePredictions();
        saveCache();
        isFetching = false;
        return true;
    } catch (err) {
        console.error('Fetch error:', err.message);
        lastFetchError = err.message;
        isFetching = false;
        return false;
    }
}

// ========== KHỞI TẠO SERVER ==========
loadCache();
if (sessions.length === 0) {
    sessions = generateMockSessions();
    usingMock = true;
    updatePredictions();
    saveCache();
    console.log('Using mock data.');
}
setInterval(() => fetchRealData(), FETCH_INTERVAL);
setTimeout(() => fetchRealData(), 1000);

// ========== API ENDPOINTS ==========
app.use(express.json({ limit: '5mb' }));

app.get('/predict_text', (req, res) => {
    if (sessions.length === 0) return res.send('No data');
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId);
    let thuatToan = '📜 **LỊCH SỬ CÁC PHIÊN (KẾT QUẢ THỰC TẾ)**\n| Phiên | Kết quả | Xúc xắc |\n|-------|---------|---------|\n';
    const maxDisplay = Math.min(sessions.length, 100);
    for (let i = 0; i < maxDisplay; i++) {
        const s = sessions[i];
        const diceStr = s.dice.join('-');
        thuatToan += `| ${s.id_num} | ${s.result === 'TAI' ? 'Tài' : 'Xỉu'} | ${diceStr} |\n`;
    }
    if (sessions.length > 100) thuatToan += `| ... và ${sessions.length-100} phiên cũ | ... | ... |\n`;
    let thongKe = '\n📊 **THỐNG KÊ DỰ ĐOÁN**\n| Phiên | KQ thực | Dự đoán | Đánh giá |\n|-------|---------|---------|----------|\n';
    const completed = predictions.filter(p => p.correct !== null).slice(0,30);
    for (const p of completed.reverse()) {
        const actual = p.actual === 'TAI' ? 'Tài' : 'Xỉu';
        const pred = p.predicted === 'TAI' ? 'Tài' : 'Xỉu';
        const danhGia = p.correct ? '✅ Đúng' : '❌ Sai';
        thongKe += `| ${p.predictedId} | ${actual} | ${pred} | ${danhGia} |\n`;
    }
    const totalCompleted = predictions.filter(p => p.correct !== null).length;
    const correctCount = predictions.filter(p => p.correct === true).length;
    const accuracy = totalCompleted > 0 ? (correctCount / totalCompleted * 100).toFixed(1) : '0';
    thongKe += `\n📈 Tổng: ${totalCompleted} | ✅ Đúng: ${correctCount} | ❌ Sai: ${totalCompleted-correctCount} | 🎯 Tỷ lệ: ${accuracy}%\n`;
    let chot = lastPrediction ? (lastPrediction.predicted === 'TAI' ? 'Tài' : 'Xỉu') : 'Chưa có';
    let doTinCay = lastPrediction ? lastPrediction.confidence : 0;
    let statusNote = usingMock ? '\n⚠️ *Đang dùng dữ liệu mô phỏng (mock)*\n' : '';
    const resultText = `🔮 **DỰ ĐOÁN PHIÊN TIẾP THEO** 🔮
━━━━━━━━━━━━━━━━━━━━
📌 **Phiên hiện tại:** #${latest.id_num}
🎲 Xúc xắc: ${latest.dice.join('-')} (Tổng ${latest.diceSum})
🏆 Kết quả: ${latest.result === 'TAI' ? 'Tài 🔴' : 'Xỉu ⚪'}
${statusNote}
${thuatToan}
━━━━━━━━━━━━━━━━━━━━
✨ **CHỐT DỰ ĐOÁN PHIÊN #${nextId}:**  
👉 **${chot}**  
🔒 Độ tin cậy: **${doTinCay}%**  
🧠 Phương pháp: ${lastPrediction ? lastPrediction.method : 'Chưa có'}

${thongKe}
━━━━━━━━━━━━━━━━━━━━
⏱ ${new Date().toLocaleString('vi-VN')}
🔄 Tự động cập nhật mỗi 30 giây`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(resultText);
});

app.get('/predict', (req, res) => {
    if (sessions.length === 0) return res.json({ error: 'No data' });
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId);
    const completed = predictions.filter(p => p.correct !== null);
    const correctCount = completed.filter(p => p.correct === true).length;
    const totalCompleted = completed.length;
    const accuracy = totalCompleted > 0 ? (correctCount / totalCompleted * 100).toFixed(1) : '0';
    const recentPredictions = predictions.slice(0,30).map(p => ({
        phiên: p.predictedId,
        kq_thuc: p.actual ? (p.actual === 'TAI' ? 'Tài' : 'Xỉu') : null,
        du_doan: p.predicted === 'TAI' ? 'Tài' : 'Xỉu',
        danh_gia: p.correct === null ? 'Chờ' : (p.correct ? 'Đúng' : 'Sai')
    }));
    res.json({
        status: 'success',
        using_mock: usingMock,
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

app.post('/fetch', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'Missing data' });
    const parsed = tryParseSessions(data);
    if (parsed.length === 0) return res.status(400).json({ error: 'Cannot parse' });
    const existingIds = new Set(sessions.map(s => s.id));
    for (const ns of parsed) {
        if (!existingIds.has(ns.id)) sessions.push(ns);
    }
    sessions.sort((a,b) => b.id_num - a.id_num);
    if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
    usingMock = false;
    updatePredictions();
    saveCache();
    res.json({ status: 'ok', added: parsed.length, total: sessions.length });
});

app.post('/force_fetch', async (req, res) => {
    const ok = await fetchRealData();
    res.json({ fetched: ok, using_mock: usingMock, error: lastFetchError });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.length, predictions: predictions.length, using_mock: usingMock, last_error: lastFetchError });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Text report: http://localhost:${PORT}/predict_text`);
    console.log(`📊 JSON: http://localhost:${PORT}/predict`);
    console.log(`🔧 POST /fetch to submit real data manually`);
});