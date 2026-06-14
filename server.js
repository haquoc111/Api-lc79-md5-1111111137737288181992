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

// ╔══════════════════════════════════════════════════════════════════╗
// ║         OMEGA PREDICTION ENGINE v3.0 — SELF-LEARNING            ║
// ║  8 lớp phân tích độc lập · Trọng số tự học · Weighted voting   ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── Trọng số mỗi thuật toán, tự hiệu chỉnh theo độ chính xác thực tế ──
let algoWeights = {
    streak:      1.0,   // A1 – Bệt cầu
    breakStreak: 1.0,   // A2 – Bẻ cầu dài
    pingpong:    1.0,   // A3 – Cầu đảo
    balance:     1.0,   // A4 – Cân bằng cục bộ
    md5Prefix:   1.0,   // A5 – MD5 tiền tố
    md5Segment:  1.0,   // A6 – MD5 đoạn ngữ nghĩa
    idParity:    1.0,   // A7 – Chẵn lẻ ID
    markov:      1.0,   // A8 – Markov bậc 2/3
};

// Lịch sử kết quả từng algo để hiệu chỉnh trọng số
let algoHistory = {
    streak: [], breakStreak: [], pingpong: [], balance: [],
    md5Prefix: [], md5Segment: [], idParity: [], markov: [],
};
const WEIGHT_WINDOW   = 50;   // Số phiên gần nhất để tính accuracy
const WEIGHT_MIN      = 0.2;  // Trọng số tối thiểu (không loại hoàn toàn)
const WEIGHT_MAX      = 3.0;  // Trọng số tối đa

// ─────────────────────────────────────────────
// A1: STREAK — theo cầu (bệt liên tiếp)
// Logic: Khi chuỗi liên tiếp đang chạy, xu hướng tiếp tục
// ─────────────────────────────────────────────
function algoStreak(history) {
    if (history.length < 2) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);
    const last = results[0];
    let streak = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === last) streak++;
        else break;
    }
    if (streak < 2) return { pred: null, conf: 0 };
    // Cầu 2: conf 55, cầu 3: 62, cầu 4: 68, cầu 5+: 72 (không leo vô hạn)
    const conf = Math.min(52 + streak * 5, 72);
    return { pred: last, conf, detail: `bệt ${streak}` };
}

// ─────────────────────────────────────────────
// A2: BREAK STREAK — bẻ cầu dài bất thường
// Logic: Cầu rất dài (≥6) thường có xu hướng đảo chiều
// ─────────────────────────────────────────────
function algoBreakStreak(history) {
    if (history.length < 6) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);
    const last = results[0];
    let streak = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === last) streak++;
        else break;
    }
    if (streak < 6) return { pred: null, conf: 0 };
    // Học từ lịch sử: sau cầu dài thường bẻ không?
    let breakCount = 0, continueCount = 0;
    for (let i = 5; i < Math.min(history.length - 1, 200); i++) {
        // Tìm vị trí có cầu dài ≥6 trong lịch sử
        const r = history[i].result;
        let s2 = 1;
        for (let j = i + 1; j < history.length; j++) {
            if (history[j].result === r) s2++;
            else break;
        }
        if (s2 >= 6) {
            if (i > 0) {
                if (history[i - 1].result !== r) breakCount++;
                else continueCount++;
            }
        }
    }
    const total = breakCount + continueCount;
    const breakRate = total > 5 ? breakCount / total : 0.55;
    if (breakRate >= 0.5) {
        const opposite = last === 'TAI' ? 'XIU' : 'TAI';
        const conf = Math.round(50 + breakRate * 30);
        return { pred: opposite, conf, detail: `bẻ cầu ${streak}` };
    }
    return { pred: null, conf: 0 };
}

// ─────────────────────────────────────────────
// A3: PINGPONG — cầu đảo (T-X-T-X...)
// Logic: Khi cầu liên tục đảo, dự đoán tiếp tục đảo
// ─────────────────────────────────────────────
function algoPingpong(history) {
    if (history.length < 4) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);
    let ppLen = 1;
    for (let i = 1; i < Math.min(results.length, 12); i++) {
        if (results[i] !== results[i - 1]) ppLen++;
        else break;
    }
    if (ppLen < 3) return { pred: null, conf: 0 };
    const opposite = results[0] === 'TAI' ? 'XIU' : 'TAI';
    const conf = Math.min(55 + ppLen * 3, 75);
    return { pred: opposite, conf, detail: `pingpong ${ppLen}` };
}

// ─────────────────────────────────────────────
// A4: BALANCE — cân bằng cục bộ (30 phiên)
// Logic: Ngắn hạn, Tài/Xỉu có xu hướng tự cân bằng nhau
// ─────────────────────────────────────────────
function algoBalance(history) {
    const window = Math.min(history.length, 30);
    if (window < 10) return { pred: null, conf: 0 };
    const recent = history.slice(0, window);
    const taiCount = recent.filter(s => s.result === 'TAI').length;
    const xiuCount = window - taiCount;
    const diff = Math.abs(taiCount - xiuCount);
    const diffRate = diff / window;
    if (diffRate < 0.15) return { pred: null, conf: 0 }; // Quá cân bằng
    const pred = taiCount < xiuCount ? 'TAI' : 'XIU'; // Bên ít hơn được ưu tiên
    const conf = Math.round(50 + diffRate * 80);
    return { pred, conf: Math.min(conf, 70), detail: `T${taiCount}/X${xiuCount}/${window}` };
}

// ─────────────────────────────────────────────
// A5: MD5 PREFIX — so khớp tiền tố MD5
// Logic: Cùng tiền tố MD5 → cùng seed → kết quả tương tự
// ─────────────────────────────────────────────
function algoMd5Prefix(currentMd5, history) {
    if (!currentMd5 || currentMd5.length < 8) return { pred: null, conf: 0 };
    const prefixLens = [4, 6, 8, 10];
    let bestPred = null, bestConf = 0, bestDetail = '';
    for (const pLen of prefixLens) {
        const prefix = currentMd5.slice(0, pLen);
        const matches = history.filter(s =>
            s.md5 && s.md5.length >= pLen && s.md5.slice(0, pLen) === prefix && s.md5 !== currentMd5
        );
        if (matches.length < 3) continue;
        const taiCount = matches.filter(s => s.result === 'TAI').length;
        const xiuCount = matches.length - taiCount;
        const total = matches.length;
        const winSide = taiCount >= xiuCount ? 'TAI' : 'XIU';
        const winRate = Math.max(taiCount, xiuCount) / total;
        if (winRate <= 0.55) continue;
        // Tiền tố dài hơn → đáng tin hơn
        const conf = Math.round(50 + winRate * 35 + pLen * 0.5);
        if (conf > bestConf) {
            bestPred = winSide; bestConf = conf;
            bestDetail = `prefix[${pLen}] n=${total}`;
        }
    }
    return { pred: bestPred, conf: Math.min(bestConf, 88), detail: bestDetail };
}

// ─────────────────────────────────────────────
// A6: MD5 SEGMENT — so khớp từng đoạn 4 ký tự
// Logic: MD5 có cấu trúc nội tại; các đoạn giữa phản ánh entropy seed
// ─────────────────────────────────────────────
function algoMd5Segment(currentMd5, history) {
    if (!currentMd5 || currentMd5.length < 16) return { pred: null, conf: 0 };
    // Lấy 4 đoạn: [0-3], [4-7], [8-11], [12-15]
    const segments = [
        currentMd5.slice(0, 4),
        currentMd5.slice(4, 8),
        currentMd5.slice(8, 12),
        currentMd5.slice(12, 16),
    ];
    let scoreTai = 0, scoreXiu = 0, totalHits = 0;
    for (const s of history) {
        if (!s.md5 || s.md5.length < 16 || s.md5 === currentMd5) continue;
        let matchSegs = 0;
        for (let si = 0; si < 4; si++) {
            if (s.md5.slice(si * 4, si * 4 + 4) === segments[si]) matchSegs++;
        }
        if (matchSegs < 2) continue;
        const weight = matchSegs * matchSegs; // 2 segs → 4, 3 segs → 9, 4 segs → 16
        if (s.result === 'TAI') scoreTai += weight;
        else scoreXiu += weight;
        totalHits++;
    }
    if (totalHits < 3) return { pred: null, conf: 0 };
    const total = scoreTai + scoreXiu;
    const winRate = Math.max(scoreTai, scoreXiu) / total;
    if (winRate <= 0.54) return { pred: null, conf: 0 };
    const pred = scoreTai >= scoreXiu ? 'TAI' : 'XIU';
    const conf = Math.round(50 + winRate * 40);
    return { pred, conf: Math.min(conf, 85), detail: `seg n=${totalHits}` };
}

// ─────────────────────────────────────────────
// A7: ID PARITY — phân tích chẵn/lẻ ID
// Logic: Một số game seed theo ID; ID chẵn/lẻ có pattern riêng
// ─────────────────────────────────────────────
function algoIdParity(nextIdNum, history) {
    if (history.length < 20) return { pred: null, conf: 0 };
    const parity = nextIdNum % 2; // 0 = chẵn, 1 = lẻ
    const sameParityHistory = history.filter(s => s.id_num % 2 === parity).slice(0, 100);
    if (sameParityHistory.length < 10) return { pred: null, conf: 0 };
    const taiCount = sameParityHistory.filter(s => s.result === 'TAI').length;
    const xiuCount = sameParityHistory.length - taiCount;
    const total = sameParityHistory.length;
    const winRate = Math.max(taiCount, xiuCount) / total;
    if (winRate <= 0.56) return { pred: null, conf: 0 };
    const pred = taiCount >= xiuCount ? 'TAI' : 'XIU';
    const conf = Math.round(50 + winRate * 30);
    return { pred, conf: Math.min(conf, 72), detail: `id_parity=${parity === 0 ? 'chẵn' : 'lẻ'} n=${total}` };
}

// ─────────────────────────────────────────────
// A8: MARKOV bậc 2/3 — xác suất chuyển trạng thái
// Logic: P(kết quả | 2-3 phiên trước) từ lịch sử thực tế
// ─────────────────────────────────────────────
function algoMarkov(history) {
    if (history.length < 30) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);

    // Bậc 3: state = "T-X-T" → đếm kết quả tiếp theo
    const stateMap3 = {};
    for (let i = 3; i < results.length; i++) {
        const state = `${results[i]}|${results[i-1]}|${results[i-2]}`;
        if (!stateMap3[state]) stateMap3[state] = { TAI: 0, XIU: 0 };
        stateMap3[state][results[i - 3]]++;
    }
    const currentState3 = `${results[0]}|${results[1]}|${results[2]}`;
    const counts3 = stateMap3[currentState3];
    if (counts3) {
        const total = counts3.TAI + counts3.XIU;
        if (total >= 5) {
            const winRate = Math.max(counts3.TAI, counts3.XIU) / total;
            if (winRate >= 0.58) {
                const pred = counts3.TAI >= counts3.XIU ? 'TAI' : 'XIU';
                const conf = Math.round(50 + winRate * 45);
                return { pred, conf: Math.min(conf, 86), detail: `markov3 n=${total}` };
            }
        }
    }

    // Bậc 2: fallback
    const stateMap2 = {};
    for (let i = 2; i < results.length; i++) {
        const state = `${results[i]}|${results[i-1]}`;
        if (!stateMap2[state]) stateMap2[state] = { TAI: 0, XIU: 0 };
        stateMap2[state][results[i - 2]]++;
    }
    const currentState2 = `${results[0]}|${results[1]}`;
    const counts2 = stateMap2[currentState2];
    if (counts2) {
        const total = counts2.TAI + counts2.XIU;
        if (total >= 8) {
            const winRate = Math.max(counts2.TAI, counts2.XIU) / total;
            if (winRate >= 0.56) {
                const pred = counts2.TAI >= counts2.XIU ? 'TAI' : 'XIU';
                const conf = Math.round(50 + winRate * 35);
                return { pred, conf: Math.min(conf, 78), detail: `markov2 n=${total}` };
            }
        }
    }
    return { pred: null, conf: 0 };
}

// ─────────────────────────────────────────────
// WEIGHT ENGINE — tự học trọng số từ kết quả thực tế
// ─────────────────────────────────────────────
function recordAlgoResult(algoName, prediction, actual) {
    if (!prediction) return;
    const correct = prediction === actual ? 1 : 0;
    algoHistory[algoName].unshift(correct);
    if (algoHistory[algoName].length > WEIGHT_WINDOW) {
        algoHistory[algoName] = algoHistory[algoName].slice(0, WEIGHT_WINDOW);
    }
}

function recalcWeights() {
    for (const name of Object.keys(algoWeights)) {
        const hist = algoHistory[name];
        if (hist.length < 5) { algoWeights[name] = 1.0; continue; }
        const accuracy = hist.reduce((a, b) => a + b, 0) / hist.length;
        // Ánh xạ: 50% accuracy → trọng số 0.2; 80%+ → trọng số 3.0
        const raw = (accuracy - 0.5) / 0.3; // -inf..1
        algoWeights[name] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX,
            WEIGHT_MIN + (WEIGHT_MAX - WEIGHT_MIN) * Math.max(0, raw)
        ));
    }
}

// ─────────────────────────────────────────────
// OMEGA FUSION — gộp 8 thuật toán thành 1 phán quyết
// ─────────────────────────────────────────────
function omegaPredict(history, nextIdNum) {
    if (history.length < 2) {
        return { prediction: 'TAI', confidence: 50, method: 'Chưa đủ dữ liệu', breakdown: {} };
    }

    const latest = history[0];
    const histExcludingLatest = history.slice(1);

    // Chạy 8 thuật toán
    const algos = {
        streak:      algoStreak(history),
        breakStreak: algoBreakStreak(history),
        pingpong:    algoPingpong(history),
        balance:     algoBalance(history),
        md5Prefix:   algoMd5Prefix(latest.md5, histExcludingLatest),
        md5Segment:  algoMd5Segment(latest.md5, histExcludingLatest),
        idParity:    algoIdParity(nextIdNum, history),
        markov:      algoMarkov(history),
    };

    // Weighted voting
    let scoreTai = 0, scoreXiu = 0;
    const activeAlgos = [];
    const algoNames = {
        streak: 'Bệt cầu', breakStreak: 'Bẻ cầu', pingpong: 'Pingpong',
        balance: 'Cân bằng', md5Prefix: 'MD5-Prefix', md5Segment: 'MD5-Segment',
        idParity: 'ID-Parity', markov: 'Markov',
    };

    for (const [name, result] of Object.entries(algos)) {
        if (!result.pred || result.conf <= 0) continue;
        const weight = algoWeights[name] * (result.conf / 100);
        if (result.pred === 'TAI') scoreTai += weight;
        else scoreXiu += weight;
        activeAlgos.push({ name: algoNames[name], pred: result.pred, conf: result.conf,
            weight: algoWeights[name].toFixed(2), detail: result.detail || '' });
    }

    const totalScore = scoreTai + scoreXiu;
    let finalPred, finalConf, method;

    if (totalScore === 0) {
        // Fallback tuyệt đối: thống kê 50 phiên gần nhất
        const n = Math.min(history.length, 50);
        const taiN = history.slice(0, n).filter(s => s.result === 'TAI').length;
        finalPred = taiN >= n / 2 ? 'TAI' : 'XIU';
        finalConf = Math.round(50 + Math.abs(taiN - n / 2) / n * 40);
        method = 'Fallback thống kê';
    } else {
        const winScore = Math.max(scoreTai, scoreXiu);
        finalPred = scoreTai >= scoreXiu ? 'TAI' : 'XIU';
        // Confidence = tỷ lệ phiếu thắng, scale 50-94
        const winRate = winScore / totalScore;
        finalConf = Math.round(50 + (winRate - 0.5) * 88);
        finalConf = Math.max(50, Math.min(finalConf, 94));

        const dominant = activeAlgos.filter(a => a.pred === finalPred);
        const against  = activeAlgos.filter(a => a.pred !== finalPred);
        if (dominant.length >= 5 && against.length === 0) {
            method = `Đồng thuận tuyệt đối (${dominant.length}/8)`;
        } else if (dominant.length > against.length * 2) {
            method = `Áp đảo: ${dominant.map(a => a.name).join(', ')}`;
        } else {
            method = `Weighted vote ${dominant.length}v${against.length} (${finalPred === 'TAI' ? 'Tài' : 'Xỉu'})`;
        }
    }

    // Ghi nhận dự đoán từng algo để học sau
    const breakdown = {};
    for (const [name, result] of Object.entries(algos)) {
        breakdown[name] = { pred: result.pred, conf: result.conf,
            weight: algoWeights[name], detail: result.detail || '' };
    }

    return { prediction: finalPred, confidence: finalConf, method,
        breakdown, activeCount: activeAlgos.length, activeAlgos };
}

// ─────────────────────────────────────────────
// UPDATE — cập nhật dự đoán + học lại trọng số
// ─────────────────────────────────────────────
function updatePredictions() {
    if (sessions.length === 0) return;
    const latest    = sessions[0];
    const nextIdNum = latest.id_num + 1;

    // Học trọng số: với mỗi phiên vừa có kết quả thực tế,
    // truy tìm dự đoán từng algo tại thời điểm đó và ghi nhận đúng/sai
    for (const sess of sessions.slice(0, 20)) {
        const pred = predictions.find(p => p.predictedId === sess.id_num && p.correct !== null);
        if (!pred || !pred.algoBreakdown) continue;
        for (const [algoName, algoResult] of Object.entries(pred.algoBreakdown)) {
            if (algoResult.pred) {
                recordAlgoResult(algoName, algoResult.pred, sess.result);
            }
        }
    }
    recalcWeights();

    // Dự đoán phiên tiếp theo
    const result = omegaPredict(sessions, nextIdNum);

    const existing = predictions.find(p => p.predictedId === nextIdNum);
    if (!existing) {
        predictions.unshift({
            predictedId:   nextIdNum,
            predicted:     result.prediction,
            confidence:    result.confidence,
            method:        result.method,
            algoBreakdown: result.breakdown,
            activeAlgos:   result.activeAlgos,
            actual:        null,
            correct:       null,
            timestamp:     Date.now(),
        });
    } else if (existing.correct === null) {
        existing.predicted     = result.prediction;
        existing.confidence    = result.confidence;
        existing.method        = result.method;
        existing.algoBreakdown = result.breakdown;
        existing.activeAlgos   = result.activeAlgos;
    }

    if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
    saveCache();

    const icon = result.prediction === 'TAI' ? '🔴' : '⚪';
    console.log(`[OMEGA] Phiên #${nextIdNum}: ${icon} ${result.prediction} ${result.confidence}% | ${result.method} | ${result.activeCount}/8 thuật toán`);
    const wStr = Object.entries(algoWeights).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');
    console.log(`[WEIGHT] ${wStr}`);
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
    if (sessions.length === 0) return res.send('Chưa có dữ liệu. Vui lòng thử lại sau.');
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const lastPrediction = predictions.find(p => p.predictedId === nextId);

    const SEP  = '━'.repeat(38);
    const sep2 = '─'.repeat(38);
    const pad  = (s, w) => String(s).padEnd(w);

    // ── Chốt dự đoán ──
    const chot       = lastPrediction ? (lastPrediction.predicted === 'TAI' ? '🔴 TÀI' : '⚪ XỈU') : '❓ Chưa có';
    const doTinCay   = lastPrediction ? lastPrediction.confidence : 0;
    const phuongPhap = lastPrediction ? lastPrediction.method : 'Chưa xác định';

    // ── Thanh tin cậy ──
    const barLen  = 20;
    const filled  = Math.round(doTinCay / 100 * barLen);
    const barStr  = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const tinCayBar = `[${barStr}] ${doTinCay}%`;

    // ── Breakdown 8 thuật toán ──
    let algoLines = '';
    const algoLabelMap = {
        streak: 'Bệt cầu     ', breakStreak: 'Bẻ cầu      ', pingpong: 'Pingpong    ',
        balance: 'Cân bằng    ', md5Prefix: 'MD5-Prefix  ', md5Segment: 'MD5-Segment ',
        idParity: 'ID-Parity   ', markov: 'Markov      ',
    };
    if (lastPrediction && lastPrediction.algoBreakdown) {
        for (const [key, label] of Object.entries(algoLabelMap)) {
            const a = lastPrediction.algoBreakdown[key];
            if (!a) continue;
            const icon = !a.pred ? '⬜' : (a.pred === 'TAI' ? '🔴' : '⚪');
            const predStr = a.pred ? `${a.pred} ${a.conf}%` : 'Không đủ tín hiệu';
            const wStr = `w=${parseFloat(a.weight || 1).toFixed(2)}`;
            algoLines += `  ${icon} ${label} ${pad(predStr, 12)} ${wStr}\n`;
        }
    } else {
        algoLines = '  (Chưa có dữ liệu breakdown)\n';
    }

    // ── Trọng số tự học ──
    const weightStr = Object.entries(algoWeights)
        .map(([k, v]) => `${k.replace('Segment','Seg').replace('Prefix','Pre')}:${v.toFixed(2)}`)
        .join('  ');

    // ── Lịch sử phiên ──
    const maxDisplay = Math.min(sessions.length, 20);
    let histLines = `\n📜 ${maxDisplay} PHIÊN GẦN NHẤT\n${sep2}\n`;
    histLines += `${pad('Phiên', 10)} ${pad('K.Quả', 8)} MD5 (8 ký tự đầu)\n${sep2}\n`;
    for (let i = 0; i < maxDisplay; i++) {
        const s = sessions[i];
        const kq = s.result === 'TAI' ? '🔴 Tài  ' : '⚪ Xỉu  ';
        const md5short = s.md5 ? s.md5.slice(0, 8) : '—';
        histLines += `${pad('#' + s.id_num, 10)} ${kq} ${md5short}\n`;
    }
    if (sessions.length > maxDisplay) histLines += `  ... và ${sessions.length - maxDisplay} phiên cũ hơn\n`;

    // ── Thống kê dự đoán ──
    const completed    = predictions.filter(p => p.correct !== null);
    const correctCount = completed.filter(p => p.correct === true).length;
    const totalCmpl    = completed.length;
    const accuracy     = totalCmpl > 0 ? (correctCount / totalCmpl * 100).toFixed(1) : '—';

    let statsLines = `\n📊 THỐNG KÊ DỰ ĐOÁN GẦN ĐÂY\n${sep2}\n`;
    statsLines += `${pad('Phiên', 9)} ${pad('Thực tế', 9)} ${pad('Dự đoán', 9)} Đánh giá\n${sep2}\n`;
    for (const p of completed.slice(0, 12).reverse()) {
        const actual  = p.actual    === 'TAI' ? '🔴 Tài  ' : '⚪ Xỉu  ';
        const predStr = p.predicted === 'TAI' ? '🔴 Tài  ' : '⚪ Xỉu  ';
        const mark    = p.correct ? '✅ Đúng' : '❌ Sai ';
        statsLines += `${pad('#' + p.predictedId, 9)} ${actual} ${predStr} ${mark}\n`;
    }
    statsLines += `${sep2}\n`;
    statsLines += `Tổng: ${totalCmpl}  ✅ ${correctCount}  ❌ ${totalCmpl - correctCount}  🎯 ${accuracy}%\n`;

    const statusNote = usingMock ? `\n⚠️  MOCK DATA — chưa kết nối API thật\n` : '';

    const out =
`${SEP}
🔮  OMEGA ENGINE — DỰ ĐOÁN TÀI XỈU
${SEP}
📌  Phiên hiện tại : #${latest.id_num}
🏆  Kết quả         : ${latest.result === 'TAI' ? '🔴 Tài' : '⚪ Xỉu'}
🔑  MD5             : ${latest.md5 ? latest.md5.slice(0, 16) + '...' : '—'}
${statusNote}${SEP}
✨  CHỐT PHIÊN #${nextId}
👉  ${chot}
📊  Tin cậy  : ${tinCayBar}
🧠  Phương pháp: ${phuongPhap}
${sep2}
🔬 PHÂN TÍCH 8 THUẬT TOÁN
${algoLines}${sep2}
⚖️  TRỌNG SỐ TỰ HỌC
  ${weightStr}
${histLines}${statsLines}${SEP}
⏱  ${new Date().toLocaleString('vi-VN')}   🔄 Mỗi 30 giây
${SEP}`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(out);
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
            chot: lastPrediction ? (lastPrediction.predicted === 'TAI' ? 'Tài' : 'Xỉu') : 'Chưa có',
            do_tin_cay: lastPrediction ? lastPrediction.confidence : 0,
            phuong_phap: lastPrediction ? lastPrediction.method : 'Chưa xác định'
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
    const sep = '─'.repeat(45);
    console.log(`\n${sep}`);
    console.log(`🚀  Server khởi động tại cổng ${PORT}`);
    console.log(`${sep}`);
    console.log(`📝  Báo cáo dạng text : http://localhost:${PORT}/predict_text`);
    console.log(`📊  Kết quả JSON      : http://localhost:${PORT}/predict`);
    console.log(`❤️   Kiểm tra sức khỏe : http://localhost:${PORT}/health`);
    console.log(`🔧  POST /fetch       : Gửi dữ liệu thủ công`);
    console.log(`🔄  POST /force_fetch : Ép fetch từ API ngay lập tức`);
    console.log(`${sep}\n`);
});