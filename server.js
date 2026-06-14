// server.js - Omega Prediction Engine v4.0
// Siêu bẻ cầu, tự học sâu, cập nhật tự động từ API

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = 'https://treo-lc79-h6zy.onrender.com/';
const MAX_HISTORY = 100000;
const FETCH_INTERVAL = 30000;        // 30 giây
const CACHE_FILE = path.join(__dirname, 'sessions_cache.json');
const RETRY_DELAY = 5000;

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

// ========== PARSE DỮ LIỆU TỪ API GỐC (fix triệt để dice) ==========
function tryParseSessions(rawData) {
    let list = [];
    console.log('Raw data type:', typeof rawData);
    if (typeof rawData === 'string') {
        console.log('Raw string preview:', rawData.slice(0, 500));
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
            
            // ========== FIX DICE: THU THẬP TỪ NHIỀU NGUỒN ==========
            let dice = [];
            let diceSum = 0;
            
            // Các dạng mảng
            if (obj.dice && Array.isArray(obj.dice)) dice = obj.dice.slice(0,3);
            else if (obj.xucXac && Array.isArray(obj.xucXac)) dice = obj.xucXac.slice(0,3);
            else if (obj.dice_result && Array.isArray(obj.dice_result)) dice = obj.dice_result.slice(0,3);
            else if (obj.dice_value && Array.isArray(obj.dice_value)) dice = obj.dice_value.slice(0,3);
            else if (obj.values && Array.isArray(obj.values)) dice = obj.values.slice(0,3);
            
            // Dạng dice1,dice2,dice3
            if (dice.length !== 3 && obj.dice1 && obj.dice2 && obj.dice3) {
                dice = [obj.dice1, obj.dice2, obj.dice3];
            }
            // Dạng chuỗi "3-4-5" hoặc "3,4,5"
            if (dice.length !== 3 && obj.dice && typeof obj.dice === 'string') {
                const parts = obj.dice.split(/[-_,]/).map(Number);
                if (parts.length === 3) dice = parts;
            }
            // Dạng "dice": [3,4,5] dạng số
            if (dice.length !== 3 && obj.dice && Array.isArray(obj.dice)) dice = obj.dice.slice(0,3);
            
            // Nếu có tổng nhưng không có dice -> ước lượng (chỉ hiển thị)
            if (dice.length !== 3 && (obj.sum || obj.total || obj.diceSum)) {
                const sum = parseInt(obj.sum || obj.total || obj.diceSum);
                if (!isNaN(sum) && sum >= 3 && sum <= 18) {
                    let a = Math.min(6, Math.max(1, Math.floor(sum/3)));
                    let b = Math.min(6, Math.max(1, a + (sum % 3) - 1));
                    let c = sum - a - b;
                    if (c < 1) { c = 1; a = Math.min(6, a-1); b = Math.min(6, b-1); }
                    if (c > 6) { c = 6; a = Math.max(1, a-1); b = Math.max(1, b-1); }
                    dice = [a, b, c];
                }
            }
            
            // Chuẩn hóa
            if (dice.length !== 3) dice = [0,0,0];
            else dice = dice.map(d => parseInt(d));
            diceSum = dice.reduce((a,b)=>a+b,0);
            if (diceSum === 0 && (obj.sum || obj.total || obj.diceSum)) {
                diceSum = parseInt(obj.sum || obj.total || obj.diceSum);
            }
            
            const md5 = (obj.md5 || obj.hash || '').replace(/\s/g, '');
            parsed.push({ id: String(id), id_num: idNum, result, dice, diceSum, md5 });
        } catch(e) { console.log('Item parse error:', e.message); }
    }
    console.log(`Parsed ${parsed.length} valid sessions.`);
    if (parsed.length > 0) console.log('First session sample:', JSON.stringify(parsed[0]));
    return parsed;
}

// ╔═══════════════════════════════════════════════════════════════════╗
// ║      OMEGA PREDICTION ENGINE v4.0 — SUPER ADAPTIVE                ║
// ║  10 thuật toán · tự học trọng số · bẻ cầu thông minh              ║
// ╚═══════════════════════════════════════════════════════════════════╝

// Trọng số mỗi thuật toán
let algoWeights = {
    streak:      1.0,   // bệt cầu
    breakStreak: 1.0,   // bẻ cầu dài
    pingpong:    1.0,   // cầu đảo
    balance:     1.0,   // cân bằng ngắn hạn
    md5Prefix:   1.0,
    md5Segment:  1.0,
    idParity:    1.0,
    markov:      1.0,
    variance:    1.0,   // mới: phân tích phương sai
    entropy:     1.0,   // mới: entropy cục bộ
};

let algoHistory = {
    streak: [], breakStreak: [], pingpong: [], balance: [],
    md5Prefix: [], md5Segment: [], idParity: [], markov: [],
    variance: [], entropy: []
};
const WEIGHT_WINDOW = 50;
const WEIGHT_MIN = 0.2;
const WEIGHT_MAX = 3.5;

// ========== CƠ CHẾ BẺ CẦU SIÊU BÁ ==========
let recentAccuracy = [];        // lưu true/false
const BREAK_WINDOW = 5;
const BREAK_THRESHOLD = 0.3;    // dưới 30% đúng thì kích hoạt
let breakerActive = false;
let breakerFactor = 1.0;        // 1 = bình thường, -1 = đảo ngược

function recordOutcome(correct) {
    recentAccuracy.unshift(correct);
    if (recentAccuracy.length > BREAK_WINDOW) recentAccuracy.pop();
    
    if (recentAccuracy.length >= BREAK_WINDOW) {
        const correctCount = recentAccuracy.filter(c => c === true).length;
        const acc = correctCount / BREAK_WINDOW;
        if (acc < BREAK_THRESHOLD && !breakerActive) {
            breakerActive = true;
            breakerFactor = -1;
            console.log(`🔥 SIÊU BẺ CẦU: chỉ ${(acc*100).toFixed(0)}% đúng trong ${BREAK_WINDOW} phiên -> ĐẢO NGƯỢC DỰ ĐOÁN`);
            // Ngoài đảo, còn giảm trọng số các thuật toán đang thua lỗ (được thực hiện trong recalcWeights)
        } else if (breakerActive && acc >= 0.6) {
            breakerActive = false;
            breakerFactor = 1.0;
            console.log(`✅ HỒI PHỤC: ${(acc*100).toFixed(0)}% đúng -> TẮT CHẾ ĐỘ BẺ`);
        }
    }
}

function applySuperBreaker(prediction, confidence) {
    if (!breakerActive) return { prediction, confidence };
    const newPred = prediction === 'TAI' ? 'XIU' : 'TAI';
    const newConf = Math.min(85, confidence * 0.9);
    console.log(`🔁 SUPER BREAKER: ${prediction} (${confidence}%) -> ${newPred} (${newConf.toFixed(0)}%)`);
    return { prediction: newPred, confidence: newConf };
}

// ────────────────────────────── CÁC THUẬT TOÁN NÂNG CAO ──────────────────────────────
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
    let conf = 50 + Math.min(streak * 3, 25);
    conf = Math.min(conf, 75);
    return { pred: last, conf, detail: `bệt ${streak}` };
}

function algoBreakStreak(history) {
    if (history.length < 8) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);
    const last = results[0];
    let streak = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === last) streak++;
        else break;
    }
    if (streak < 6) return { pred: null, conf: 0 };
    // Xác suất bẻ dựa trên lịch sử
    let breakCount = 0, totalEvents = 0;
    for (let i = 5; i < history.length - 1; i++) {
        let s = history[i].result;
        let len = 1;
        for (let j = i+1; j < history.length; j++) {
            if (history[j].result === s) len++;
            else break;
        }
        if (len >= 6) {
            totalEvents++;
            if (history[i-1].result !== s) breakCount++;
        }
    }
    const breakRate = totalEvents > 3 ? breakCount / totalEvents : 0.5;
    if (breakRate >= 0.45) {
        const opposite = last === 'TAI' ? 'XIU' : 'TAI';
        let conf = 55 + breakRate * 25;
        return { pred: opposite, conf: Math.min(conf, 80), detail: `bẻ cầu ${streak}` };
    }
    return { pred: null, conf: 0 };
}

function algoPingpong(history) {
    if (history.length < 4) return { pred: null, conf: 0 };
    const results = history.map(s => s.result);
    let ppLen = 1;
    for (let i = 1; i < Math.min(results.length, 15); i++) {
        if (results[i] !== results[i-1]) ppLen++;
        else break;
    }
    if (ppLen < 3) return { pred: null, conf: 0 };
    const opposite = results[0] === 'TAI' ? 'XIU' : 'TAI';
    let conf = 55 + Math.min(ppLen * 2, 20);
    return { pred: opposite, conf: Math.min(conf, 78), detail: `pingpong ${ppLen}` };
}

function algoBalance(history) {
    const window = Math.min(history.length, 30);
    if (window < 10) return { pred: null, conf: 0 };
    const recent = history.slice(0, window);
    const taiCount = recent.filter(s => s.result === 'TAI').length;
    const xiuCount = window - taiCount;
    const diff = Math.abs(taiCount - xiuCount);
    const diffRate = diff / window;
    if (diffRate < 0.12) return { pred: null, conf: 0 };
    const pred = taiCount < xiuCount ? 'TAI' : 'XIU';
    let conf = 50 + diffRate * 70;
    return { pred, conf: Math.min(conf, 74), detail: `T${taiCount}X${xiuCount}` };
}

function algoMd5Prefix(currentMd5, history) {
    if (!currentMd5 || currentMd5.length < 8) return { pred: null, conf: 0 };
    const prefixLens = [4,6,8,10];
    let best = null, bestConf = 0;
    for (const pLen of prefixLens) {
        const prefix = currentMd5.slice(0, pLen);
        const matches = history.filter(s => s.md5 && s.md5.startsWith(prefix) && s.md5 !== currentMd5);
        if (matches.length < 3) continue;
        const tai = matches.filter(s => s.result === 'TAI').length;
        const xiu = matches.length - tai;
        const winRate = Math.max(tai, xiu) / matches.length;
        if (winRate <= 0.55) continue;
        let conf = 50 + winRate * 35 + pLen * 0.8;
        if (conf > bestConf) {
            bestConf = conf;
            best = { pred: tai >= xiu ? 'TAI' : 'XIU', conf, detail: `prefix${pLen} n=${matches.length}` };
        }
    }
    return best || { pred: null, conf: 0 };
}

function algoMd5Segment(currentMd5, history) {
    if (!currentMd5 || currentMd5.length < 16) return { pred: null, conf: 0 };
    const segs = [currentMd5.slice(0,4), currentMd5.slice(4,8), currentMd5.slice(8,12), currentMd5.slice(12,16)];
    let scoreTai = 0, scoreXiu = 0, total = 0;
    for (const s of history) {
        if (!s.md5 || s.md5.length < 16 || s.md5 === currentMd5) continue;
        let match = 0;
        for (let i=0; i<4; i++) if (s.md5.slice(i*4, i*4+4) === segs[i]) match++;
        if (match < 2) continue;
        const w = match * match;
        if (s.result === 'TAI') scoreTai += w;
        else scoreXiu += w;
        total++;
    }
    if (total < 3) return { pred: null, conf: 0 };
    const totalScore = scoreTai + scoreXiu;
    const winRate = Math.max(scoreTai, scoreXiu) / totalScore;
    if (winRate < 0.55) return { pred: null, conf: 0 };
    let conf = 50 + winRate * 40;
    return { pred: scoreTai >= scoreXiu ? 'TAI' : 'XIU', conf: Math.min(conf, 86), detail: `seg n=${total}` };
}

function algoIdParity(nextIdNum, history) {
    if (history.length < 20) return { pred: null, conf: 0 };
    const parity = nextIdNum % 2;
    const same = history.filter(s => (s.id_num % 2) === parity);
    if (same.length < 10) return { pred: null, conf: 0 };
    const tai = same.filter(s => s.result === 'TAI').length;
    const xiu = same.length - tai;
    const winRate = Math.max(tai, xiu) / same.length;
    if (winRate < 0.57) return { pred: null, conf: 0 };
    let conf = 50 + winRate * 30;
    return { pred: tai >= xiu ? 'TAI' : 'XIU', conf: Math.min(conf, 75), detail: `id ${parity===0?'chẵn':'lẻ'} n=${same.length}` };
}

function algoMarkov(history) {
    if (history.length < 30) return { pred: null, conf: 0 };
    const res = history.map(s => s.result);
    // bậc 3
    const map3 = {};
    for (let i=3; i<res.length; i++) {
        const key = `${res[i-3]}|${res[i-2]}|${res[i-1]}`;
        if (!map3[key]) map3[key] = { TAI:0, XIU:0 };
        map3[key][res[i]]++;
    }
    const cur = `${res[0]}|${res[1]}|${res[2]}`;
    if (map3[cur]) {
        const total = map3[cur].TAI + map3[cur].XIU;
        if (total >= 4) {
            const win = Math.max(map3[cur].TAI, map3[cur].XIU);
            const winRate = win / total;
            if (winRate >= 0.6) {
                let pred = map3[cur].TAI >= map3[cur].XIU ? 'TAI' : 'XIU';
                let conf = 55 + winRate * 35;
                return { pred, conf: Math.min(conf, 85), detail: `markov3 n=${total}` };
            }
        }
    }
    // bậc 2
    const map2 = {};
    for (let i=2; i<res.length; i++) {
        const key = `${res[i-2]}|${res[i-1]}`;
        if (!map2[key]) map2[key] = { TAI:0, XIU:0 };
        map2[key][res[i]]++;
    }
    const cur2 = `${res[0]}|${res[1]}`;
    if (map2[cur2]) {
        const total = map2[cur2].TAI + map2[cur2].XIU;
        if (total >= 6) {
            const win = Math.max(map2[cur2].TAI, map2[cur2].XIU);
            const winRate = win / total;
            if (winRate >= 0.58) {
                let pred = map2[cur2].TAI >= map2[cur2].XIU ? 'TAI' : 'XIU';
                let conf = 50 + winRate * 30;
                return { pred, conf: Math.min(conf, 78), detail: `markov2 n=${total}` };
            }
        }
    }
    return { pred: null, conf: 0 };
}

// Thuật toán mới: phân tích phương sai (độ phân tán của kết quả)
function algoVariance(history) {
    const window = Math.min(history.length, 20);
    if (window < 10) return { pred: null, conf: 0 };
    const res = history.slice(0, window).map(s => s.result === 'TAI' ? 1 : 0);
    const mean = res.reduce((a,b)=>a+b,0)/window;
    let variance = 0;
    for (let v of res) variance += (v - mean)**2;
    variance /= window;
    // variance cao -> khó đoán, variance thấp -> xu hướng rõ
    if (variance > 0.24) return { pred: null, conf: 0 };
    // variance thấp, dự đoán theo xu hướng chính
    const taiCount = res.filter(v=>v===1).length;
    const pred = taiCount >= window/2 ? 'TAI' : 'XIU';
    let conf = 55 + (0.25 - variance) * 100;
    return { pred, conf: Math.min(conf, 72), detail: `var=${variance.toFixed(3)}` };
}

// Thuật toán entropy cục bộ: đo độ hỗn loạn
function algoEntropy(history) {
    const window = Math.min(history.length, 15);
    if (window < 6) return { pred: null, conf: 0 };
    const res = history.slice(0, window).map(s => s.result);
    let transitions = { TT:0, TX:0, XT:0, XX:0 };
    for (let i=0; i<res.length-1; i++) {
        const pair = res[i]+res[i+1];
        transitions[pair]++;
    }
    const totalTrans = res.length-1;
    if (totalTrans < 3) return { pred: null, conf: 0 };
    const entropy = - (transitions.TT/totalTrans * Math.log2(transitions.TT/totalTrans+1e-6) +
                       transitions.TX/totalTrans * Math.log2(transitions.TX/totalTrans+1e-6) +
                       transitions.XT/totalTrans * Math.log2(transitions.XT/totalTrans+1e-6) +
                       transitions.XX/totalTrans * Math.log2(transitions.XX/totalTrans+1e-6));
    // entropy cao -> khó đoán, thấp -> có cầu rõ
    if (entropy > 1.8) return { pred: null, conf: 0 };
    // Dự đoán theo cặp cuối
    const lastPair = res[0]+res[1];
    let pred = null;
    if (lastPair === 'TAITAI') pred = 'TAI';
    else if (lastPair === 'XIUXIU') pred = 'XIU';
    else if (lastPair === 'TAIXIU') pred = 'XIU';  // đảo -> tiếp đảo?
    else if (lastPair === 'XIUTAI') pred = 'TAI';
    if (!pred) return { pred: null, conf: 0 };
    let conf = 55 + (1.8 - entropy) * 15;
    return { pred, conf: Math.min(conf, 70), detail: `entropy=${entropy.toFixed(2)}` };
}

// WEIGHT ENGINE
function recordAlgoResult(algoName, prediction, actual) {
    if (!prediction) return;
    const correct = prediction === actual ? 1 : 0;
    algoHistory[algoName].unshift(correct);
    if (algoHistory[algoName].length > WEIGHT_WINDOW) algoHistory[algoName] = algoHistory[algoName].slice(0, WEIGHT_WINDOW);
}
function recalcWeights() {
    for (const name of Object.keys(algoWeights)) {
        const hist = algoHistory[name];
        if (hist.length < 5) { algoWeights[name] = 1.0; continue; }
        const acc = hist.reduce((a,b)=>a+b,0)/hist.length;
        // Ánh xạ: 50% -> 0.2, 80% -> 3.0
        let w = (acc - 0.5) / 0.3;
        w = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, WEIGHT_MIN + (WEIGHT_MAX-WEIGHT_MIN)*Math.max(0, w)));
        // Nếu đang trong chế độ bẻ cầu, giảm trọng số các thuật toán đang dự đoán sai nhiều
        if (breakerActive) {
            // Đơn giản: giảm 20% trọng số nếu độ chính xác dưới 60%
            if (acc < 0.6) w *= 0.8;
        }
        algoWeights[name] = w;
    }
}

// OMEGA FUSION v4.0
function omegaPredict(history, nextIdNum) {
    if (history.length < 2) return { prediction: 'TAI', confidence: 50, method: 'Chưa đủ dữ liệu', breakdown: {} };
    const latest = history[0];
    const histExcludingLatest = history.slice(1);
    const algos = {
        streak:      algoStreak(history),
        breakStreak: algoBreakStreak(history),
        pingpong:    algoPingpong(history),
        balance:     algoBalance(history),
        md5Prefix:   algoMd5Prefix(latest.md5, histExcludingLatest),
        md5Segment:  algoMd5Segment(latest.md5, histExcludingLatest),
        idParity:    algoIdParity(nextIdNum, history),
        markov:      algoMarkov(history),
        variance:    algoVariance(history),
        entropy:     algoEntropy(history)
    };
    let scoreTai = 0, scoreXiu = 0;
    const active = [];
    const algoNames = {
        streak:'Bệt', breakStreak:'Bẻ cầu', pingpong:'Pingpong', balance:'Cân bằng',
        md5Prefix:'MD5-Pre', md5Segment:'MD5-Seg', idParity:'ID-Parity', markov:'Markov',
        variance:'Var', entropy:'Entropy'
    };
    for (const [name, res] of Object.entries(algos)) {
        if (!res.pred || res.conf <= 0) continue;
        const weight = algoWeights[name] * (res.conf / 100);
        if (res.pred === 'TAI') scoreTai += weight;
        else scoreXiu += weight;
        active.push({ name: algoNames[name], pred: res.pred, conf: res.conf, weight: algoWeights[name].toFixed(2), detail: res.detail });
    }
    const totalScore = scoreTai + scoreXiu;
    let finalPred, finalConf, method;
    if (totalScore === 0) {
        const n = Math.min(history.length, 50);
        const taiN = history.slice(0,n).filter(s=>s.result==='TAI').length;
        finalPred = taiN >= n/2 ? 'TAI' : 'XIU';
        finalConf = 50 + Math.abs(taiN - n/2)/n*40;
        method = 'Fallback thống kê';
    } else {
        const winScore = Math.max(scoreTai, scoreXiu);
        finalPred = scoreTai >= scoreXiu ? 'TAI' : 'XIU';
        const winRate = winScore / totalScore;
        finalConf = 50 + (winRate - 0.5) * 88;
        finalConf = Math.min(94, Math.max(50, finalConf));
        const dominant = active.filter(a=>a.pred===finalPred).length;
        const against = active.length - dominant;
        if (dominant >= 7) method = `Đồng thuận tuyệt đối (${dominant}/10)`;
        else if (dominant > against*2) method = `Áp đảo: ${dominant}v${against}`;
        else method = `Weighted vote ${dominant}v${against}`;
    }
    const breakdown = {};
    for (const [name, res] of Object.entries(algos)) breakdown[name] = { pred: res.pred, conf: res.conf, weight: algoWeights[name], detail: res.detail };
    return { prediction: finalPred, confidence: finalConf, method, breakdown, activeCount: active.length, activeAlgos: active };
}

// UPDATE tự động + siêu bẻ
function updatePredictions() {
    if (sessions.length === 0) return;
    const latest = sessions[0];
    const nextIdNum = latest.id_num + 1;
    // Học từ các phiên đã có kết quả
    for (const sess of sessions.slice(0,20)) {
        const pred = predictions.find(p => p.predictedId === sess.id_num && p.correct !== null);
        if (pred && pred.algoBreakdown) {
            for (const [algoName, algoRes] of Object.entries(pred.algoBreakdown)) {
                if (algoRes.pred) recordAlgoResult(algoName, algoRes.pred, sess.result);
            }
        }
    }
    recalcWeights();
    let { prediction, confidence, method, breakdown, activeCount, activeAlgos } = omegaPredict(sessions, nextIdNum);
    const final = applySuperBreaker(prediction, confidence);
    prediction = final.prediction;
    confidence = final.confidence;
    if (breakerActive) method = `[SUPER BREAK] ${method}`;
    const existing = predictions.find(p => p.predictedId === nextIdNum);
    if (!existing) {
        predictions.unshift({ predictedId: nextIdNum, predicted: prediction, confidence, method,
            algoBreakdown: breakdown, activeAlgos, actual: null, correct: null, timestamp: Date.now() });
    } else if (existing.correct === null) {
        existing.predicted = prediction; existing.confidence = confidence; existing.method = method;
        existing.algoBreakdown = breakdown; existing.activeAlgos = activeAlgos;
    }
    if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
    saveCache();
    const icon = prediction === 'TAI' ? '🔴' : '⚪';
    console.log(`[OMEGA] #${nextIdNum}: ${icon} ${prediction} ${confidence}% | ${method} | ${activeCount}/10 algo`);
    if (breakerActive) console.log(`🔥 SUPER BREAKER ACTIVE (đúng ${recentAccuracy.filter(c=>c).length}/${BREAK_WINDOW} gần nhất)`);
}

// ========== FETCH DỮ LIỆU THẬT (có retry) ==========
async function fetchRealData(retry = true) {
    if (isFetching) return false;
    isFetching = true;
    try {
        console.log(`[${new Date().toISOString()}] Fetching from ${API_URL}...`);
        const resp = await axios.get(API_URL, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const parsed = tryParseSessions(resp.data);
        if (parsed.length === 0) throw new Error('No sessions parsed');
        let added = 0;
        const existingIds = new Set(sessions.map(s => s.id));
        for (const ns of parsed) {
            if (!existingIds.has(ns.id)) {
                sessions.push(ns);
                added++;
            }
        }
        sessions.sort((a,b) => b.id_num - a.id_num);
        if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
        console.log(`Added ${added} new sessions. Total: ${sessions.length}`);
        // Cập nhật kết quả dự đoán cũ
        for (const sess of parsed) {
            const pred = predictions.find(p => p.predictedId === sess.id_num);
            if (pred && pred.correct === null) {
                pred.actual = sess.result;
                pred.correct = (pred.predicted === sess.result);
                console.log(`Pred #${sess.id_num}: ${pred.correct ? '✅' : '❌'}`);
                recordOutcome(pred.correct);
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
        if (retry) {
            console.log(`Retry in ${RETRY_DELAY/1000}s...`);
            setTimeout(() => fetchRealData(false), RETRY_DELAY);
        }
        return false;
    }
}

// ========== KHỞI TẠO ==========
loadCache();
if (sessions.length === 0) {
    sessions = generateMockSessions();
    usingMock = true;
    updatePredictions();
    saveCache();
    console.log('Using mock data (real API will replace soon).');
}
setInterval(() => fetchRealData(), FETCH_INTERVAL);
setTimeout(() => fetchRealData(), 1000);

// ========== API ENDPOINTS (giữ nguyên, chỉ thêm breaker_active) ==========
app.use(express.json({ limit: '5mb' }));

app.get('/predict_text', (req, res) => {
    if (sessions.length === 0) return res.send('Chưa có dữ liệu.');
    const latest = sessions[0];
    const nextId = latest.id_num + 1;
    const pred = predictions.find(p => p.predictedId === nextId);
    const SEP = '━'.repeat(38);
    const sep2 = '─'.repeat(38);
    const pad = (s,w) => String(s).padEnd(w);
    const chot = pred ? (pred.predicted === 'TAI' ? '🔴 TÀI' : '⚪ XỈU') : '❓ Chưa có';
    const tinCay = pred ? pred.confidence : 0;
    const barLen = 20;
    const filled = Math.round(tinCay/100*barLen);
    const bar = `[${'█'.repeat(filled)}${'░'.repeat(barLen-filled)}] ${tinCay}%`;
    let algoLines = '';
    const labels = { streak:'Bệt', breakStreak:'Bẻ cầu', pingpong:'Pingpong', balance:'Cân bằng', md5Prefix:'MD5-Pre', md5Segment:'MD5-Seg', idParity:'ID-Parity', markov:'Markov', variance:'Var', entropy:'Entropy' };
    if (pred && pred.algoBreakdown) {
        for (const [key,label] of Object.entries(labels)) {
            const a = pred.algoBreakdown[key];
            if (!a) continue;
            const icon = !a.pred ? '⬜' : (a.pred==='TAI'? '🔴':'⚪');
            const predStr = a.pred ? `${a.pred} ${a.conf}%` : 'no signal';
            const wStr = `w=${(a.weight||1).toFixed(2)}`;
            algoLines += `  ${icon} ${label.padEnd(10)} ${predStr.padEnd(12)} ${wStr}\n`;
        }
    }
    let histLines = `\n📜 LỊCH SỬ 20 PHIÊN\n${sep2}\n${pad('Phiên',8)} ${pad('KQ',6)} Xúc xắc    MD5(8)\n${sep2}\n`;
    for (let i=0; i<Math.min(sessions.length,20); i++) {
        const s = sessions[i];
        const kq = s.result==='TAI' ? '🔴 Tài' : '⚪ Xỉu';
        const diceStr = s.dice && s.dice.length===3 ? s.dice.join('-') : '?-?-?';
        const md5short = s.md5 ? s.md5.slice(0,8) : '—';
        histLines += `${pad('#'+s.id_num,8)} ${kq.padEnd(6)} ${diceStr.padEnd(10)} ${md5short}\n`;
    }
    const completed = predictions.filter(p=>p.correct!==null);
    const correct = completed.filter(p=>p.correct).length;
    const acc = completed.length ? (correct/completed.length*100).toFixed(1) : '—';
    const breakerNote = breakerActive ? `\n🔥 CHẾ ĐỘ SUPER BREAKER: ĐẢO NGƯỢC DỰ ĐOÁN\n` : '';
    const out = `${SEP}\n🔮 OMEGA v4.0 — DỰ ĐOÁN TÀI XỈU\n${SEP}\n📌 Phiên #${latest.id_num} | ${latest.result==='TAI'?'🔴 Tài':'⚪ Xỉu'} | 🎲 ${latest.dice.join('-')}\n🔑 MD5: ${latest.md5?latest.md5.slice(0,16)+'...':'—'}\n${breakerNote}${SEP}\n✨ CHỐT #${nextId}: ${chot}\n📊 Tin cậy: ${bar}\n🧠 Phương pháp: ${pred?pred.method:'Chưa có'}\n${sep2}\n🔬 10 THUẬT TOÁN\n${algoLines}${sep2}\n${histLines}${sep2}\n📊 THỐNG KÊ: Đúng ${correct}/${completed.length} (${acc}%)\n${SEP}\n⏱ ${new Date().toLocaleString('vi-VN')}\n`;
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.send(out);
});

app.get('/predict', (req, res) => {
    if (sessions.length===0) return res.json({error:'No data'});
    const latest = sessions[0];
    const nextId = latest.id_num+1;
    const pred = predictions.find(p=>p.predictedId===nextId);
    const completed = predictions.filter(p=>p.correct!==null);
    const correct = completed.filter(p=>p.correct).length;
    const acc = completed.length ? (correct/completed.length*100).toFixed(1) : '0';
    res.json({
        status:'success', using_mock: usingMock, breaker_active: breakerActive,
        phien_hien_tai: { id: latest.id_num, ket_qua: latest.result==='TAI'?'Tài':'Xỉu', xuc_xac: latest.dice.join('-'), tong: latest.diceSum },
        du_doan_phien_tiep: { phien: nextId, chot: pred ? (pred.predicted==='TAI'?'Tài':'Xỉu') : 'Chưa có', do_tin_cay: pred?pred.confidence:0, phuong_phap: pred?pred.method:'Chưa xác định' },
        thong_ke_du_doan: { tong_da_danh_gia: completed.length, dung: correct, sai: completed.length-correct, ty_le_dung: `${acc}%` }
    });
});

app.post('/fetch', async (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({error:'Missing data'});
    const parsed = tryParseSessions(data);
    if (!parsed.length) return res.status(400).json({error:'Cannot parse'});
    for (const ns of parsed) if (!sessions.some(s=>s.id===ns.id)) sessions.push(ns);
    sessions.sort((a,b)=>b.id_num-a.id_num);
    if (sessions.length>MAX_HISTORY) sessions=sessions.slice(0,MAX_HISTORY);
    usingMock=false;
    updatePredictions();
    saveCache();
    res.json({status:'ok', added:parsed.length, total:sessions.length});
});

app.post('/force_fetch', async (req, res) => {
    const ok = await fetchRealData();
    res.json({ fetched: ok, using_mock: usingMock, error: lastFetchError });
});

app.get('/health', (req, res) => {
    res.json({ status:'ok', sessions: sessions.length, predictions: predictions.length, using_mock: usingMock, breaker_active: breakerActive, last_error: lastFetchError });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Omega v4.0 running on port ${PORT}`);
    console.log(`📝 text UI: http://localhost:${PORT}/predict_text`);
    console.log(`📊 JSON:    http://localhost:${PORT}/predict`);
});