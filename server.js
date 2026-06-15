// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║          OMEGA PREDICTION ENGINE v5.0 — 5000 THUẬT TOÁN SIÊU DỰ ĐOÁN      ║
// ║  Tự động lấy dữ liệu · Nắm cầu / Theo cầu / Bẻ cầu · Auto-predict        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const express   = require('express');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CẤU HÌNH API ────────────────────────────────────────────────────────────
const API_URL       = 'https://treo-lc79-h6zy.onrender.com/';
const MAX_HISTORY   = 100_000;
const FETCH_INTERVAL = 15_000;   // 15 giây cập nhật 1 lần
const RETRY_DELAY   = 5_000;
const CACHE_FILE    = path.join(__dirname, 'sessions_cache.json');

let sessions    = [];
let predictions = [];
let usingMock   = false;
let lastFetchError = null;
let isFetching  = false;

// ─── CACHE ────────────────────────────────────────────────────────────────────
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
            if (d.sessions)    sessions    = d.sessions;
            if (d.predictions) predictions = d.predictions;
            console.log(`[Cache] Loaded ${sessions.length} sessions, ${predictions.length} predictions`);
        }
    } catch (e) { console.error('[Cache] Load error:', e.message); }
}
function saveCache() {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ sessions, predictions }, null, 2)); }
    catch (e) { console.error('[Cache] Save error:', e.message); }
}

// ─── MOCK DATA (dự phòng khi API lỗi) ────────────────────────────────────────
function generateMockSessions() {
    const mock = [];
    for (let i = 0; i < 200; i++) {
        const idNum = 1_000_000 + i;
        const dice  = [rnd(1,6), rnd(1,6), rnd(1,6)];
        const diceSum = dice[0]+dice[1]+dice[2];
        const result  = diceSum >= 11 ? 'TAI' : 'XIU';
        const md5     = `mock_${idNum}_${Math.random().toString(36).slice(2,10)}`;
        mock.push({ id: String(idNum), id_num: idNum, result, dice, diceSum, md5 });
    }
    return mock.sort((a,b) => b.id_num - a.id_num);
}
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── PARSE DỮ LIỆU TỪ API (FIX TRIỆT ĐỂ DICE & TỔNG) ───────────────────────
function tryParseSessions(rawData) {
    let list = [];

    if (typeof rawData === 'string') {
        try { rawData = JSON.parse(rawData); } catch (_) {}
    }
    if (Array.isArray(rawData)) {
        list = rawData;
    } else if (rawData && typeof rawData === 'object') {
        // Tìm mảng trong các key phổ biến
        for (const key of ['data','list','result','sessions','items','history','dice_results','records']) {
            if (Array.isArray(rawData[key])) { list = rawData[key]; break; }
        }
        if (!list.length) {
            const found = Object.values(rawData).find(v => Array.isArray(v));
            if (found) list = found;
        }
    }

    const parsed = [];
    for (const item of list) {
        try {
            const obj = typeof item === 'string' ? JSON.parse(item) : item;
            if (!obj) continue;

            // ── ID ──
            const id    = obj.id || obj.session_id || obj.sessionId || obj._id || '';
            const idNum = parseInt(String(id).replace(/\D/g, ''));
            if (isNaN(idNum) || idNum === 0) continue;

            // ── KẾT QUẢ ──
            let result = String(obj.result || obj.taiXiu || obj.status || obj.outcome || '').toUpperCase();
            if      (result.includes('TAI') || result.includes('TÀI') || result === 'T') result = 'TAI';
            else if (result.includes('XIU') || result.includes('XỈU') || result === 'X') result = 'XIU';
            else continue;

            // ── XÚC XẮC (ưu tiên từ API) ──
            let dice = [];

            // Dạng mảng
            if (obj.dice  && Array.isArray(obj.dice))        dice = obj.dice.slice(0,3).map(Number);
            else if (obj.xucXac   && Array.isArray(obj.xucXac))  dice = obj.xucXac.slice(0,3).map(Number);
            else if (obj.dice_result && Array.isArray(obj.dice_result)) dice = obj.dice_result.slice(0,3).map(Number);
            else if (obj.dice_value  && Array.isArray(obj.dice_value))  dice = obj.dice_value.slice(0,3).map(Number);
            else if (obj.values && Array.isArray(obj.values)) dice = obj.values.slice(0,3).map(Number);

            // Dạng dice1/dice2/dice3
            if (dice.length !== 3 && obj.dice1 !== undefined && obj.dice2 !== undefined && obj.dice3 !== undefined) {
                dice = [Number(obj.dice1), Number(obj.dice2), Number(obj.dice3)];
            }
            // Dạng chuỗi "3-4-5" hoặc "3,4,5"
            if (dice.length !== 3 && obj.dice && typeof obj.dice === 'string') {
                const parts = obj.dice.split(/[-_,\s]+/).map(Number);
                if (parts.length === 3) dice = parts;
            }
            // Dạng object {a,b,c} hoặc {0,1,2}
            if (dice.length !== 3 && obj.dice && typeof obj.dice === 'object' && !Array.isArray(obj.dice)) {
                const vals = Object.values(obj.dice).slice(0,3).map(Number);
                if (vals.length === 3) dice = vals;
            }

            // Validate từng xúc xắc phải 1-6
            if (dice.length === 3 && dice.every(d => d >= 1 && d <= 6)) {
                // OK
            } else {
                // Không có dice hợp lệ → giữ trống thật (không giả tạo)
                dice = [];
            }

            // ── TỔNG ── lấy từ API, nếu không có tính từ dice
            let diceSum = 0;
            if (obj.sum !== undefined)     diceSum = parseInt(obj.sum);
            else if (obj.total !== undefined) diceSum = parseInt(obj.total);
            else if (obj.diceSum !== undefined) diceSum = parseInt(obj.diceSum);
            else if (obj.tong !== undefined) diceSum = parseInt(obj.tong);

            if (isNaN(diceSum) || diceSum === 0) {
                diceSum = dice.length === 3 ? dice[0]+dice[1]+dice[2] : 0;
            }

            // Validate tổng
            if (diceSum < 3 || diceSum > 18) diceSum = 0;

            // Nếu có tổng hợp lệ nhưng thiếu dice → để dice rỗng (không sinh giả)
            const md5 = (obj.md5 || obj.hash || obj.verify || '').replace(/\s/g,'');

            parsed.push({ id: String(id), id_num: idNum, result, dice, diceSum, md5 });
        } catch (e) { /* bỏ qua item lỗi */ }
    }

    parsed.sort((a,b) => b.id_num - a.id_num);
    if (parsed.length > 0) {
        console.log(`[Parse] ${parsed.length} sessions | Sample: #${parsed[0].id_num} ${parsed[0].result} dice=${JSON.stringify(parsed[0].dice)} tổng=${parsed[0].diceSum}`);
    }
    return parsed;
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                    5000 THUẬT TOÁN DỰ ĐOÁN OMEGA v5                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// ─────────── HẰNG SỐ CẦU ──────────────────────────────────────────────────────
const CAU_DETECT_MIN = 3;          // tối thiểu 3 để phát hiện cầu

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 1: NHẬN DẠNG CẦU (Streak / Bẻ / Pingpong / Tổ hợp)               [~500]
// ═════════════════════════════════════════════════════════════════════════════
function genStreakAlgos() {
    const algos = [];
    // Với mỗi tổ hợp: window [5..50], streak_min [2..8], conf_scale [0.7..1.3]
    for (const window of [5,8,10,15,20,30,50]) {
        for (const sMin of [2,3,4,5,6,7,8]) {
            for (const cScale of [0.8,1.0,1.2]) {
                algos.push({
                    name: `streak_w${window}_s${sMin}_c${cScale}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < sMin + 1) return null;
                        const last = h[0].result;
                        let streak = 1;
                        for (let i = 1; i < h.length; i++) {
                            if (h[i].result === last) streak++;
                            else break;
                        }
                        if (streak < sMin) return null;
                        const conf = Math.min(78, (50 + streak * 3)) * cScale;
                        return { pred: last, conf };
                    }
                });
            }
        }
    }
    return algos;
}

function genBreakStreakAlgos() {
    const algos = [];
    for (const window of [20,30,50,80,100]) {
        for (const breakAt of [4,5,6,7,8,9]) {
            for (const histThres of [0.4,0.45,0.5]) {
                algos.push({
                    name: `break_w${window}_b${breakAt}_h${histThres}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < 15) return null;
                        const last = h[0].result;
                        let streak = 1;
                        for (let i = 1; i < h.length; i++) {
                            if (h[i].result === last) streak++;
                            else break;
                        }
                        if (streak < breakAt) return null;
                        // Tính lịch sử bẻ cầu tương tự
                        let breakCnt = 0, total = 0;
                        for (let i = breakAt; i < h.length - 1; i++) {
                            const cur = h[i].result;
                            let len = 1;
                            for (let j = i+1; j < h.length; j++) {
                                if (h[j].result === cur) len++;
                                else break;
                            }
                            if (len >= breakAt) {
                                total++;
                                if (i > 0 && h[i-1].result !== cur) breakCnt++;
                            }
                        }
                        const rate = total > 2 ? breakCnt / total : histThres;
                        if (rate < histThres) return null;
                        const opp = last === 'TAI' ? 'XIU' : 'TAI';
                        const conf = Math.min(82, 50 + rate * 40);
                        return { pred: opp, conf };
                    }
                });
            }
        }
    }
    return algos;
}

function genPingpongAlgos() {
    const algos = [];
    for (const window of [5,8,10,15,20]) {
        for (const ppMin of [3,4,5,6]) {
            for (const mode of ['follow','break']) {  // follow=tiếp đảo, break=ngừng đảo
                algos.push({
                    name: `pingpong_w${window}_p${ppMin}_${mode}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < ppMin + 1) return null;
                        let ppLen = 1;
                        for (let i = 1; i < h.length; i++) {
                            if (h[i].result !== h[i-1].result) ppLen++;
                            else break;
                        }
                        if (ppLen < ppMin) return null;
                        const pred = mode === 'follow'
                            ? (h[0].result === 'TAI' ? 'XIU' : 'TAI')   // tiếp tục đảo
                            : h[0].result;                                // bẻ đảo
                        const conf = Math.min(76, 52 + ppLen * 2);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 2: MARKOV CHAIN BẬC CAO                                            [~700]
// ═════════════════════════════════════════════════════════════════════════════
function genMarkovAlgos() {
    const algos = [];
    for (const order of [1,2,3,4,5]) {
        for (const window of [30,50,80,100,200,500,1000,5000]) {
            for (const minSamples of [3,5,8,10]) {
                for (const minRate of [0.55,0.58,0.62,0.65]) {
                    algos.push({
                        name: `markov_o${order}_w${window}_n${minSamples}_r${minRate}`,
                        fn: (hist) => {
                            const h = hist.slice(0, window);
                            if (h.length < order + minSamples) return null;
                            const res = h.map(s => s.result);
                            const map = {};
                            for (let i = order; i < res.length; i++) {
                                const key = res.slice(i-order, i).join('|');
                                if (!map[key]) map[key] = { TAI: 0, XIU: 0 };
                                map[key][res[i]]++;
                            }
                            const curKey = res.slice(0, order).join('|');
                            const entry  = map[curKey];
                            if (!entry) return null;
                            const total = entry.TAI + entry.XIU;
                            if (total < minSamples) return null;
                            const win  = Math.max(entry.TAI, entry.XIU);
                            const rate = win / total;
                            if (rate < minRate) return null;
                            const pred = entry.TAI >= entry.XIU ? 'TAI' : 'XIU';
                            const conf = Math.min(88, 50 + rate * 45);
                            return { pred, conf };
                        }
                    });
                }
            }
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 3: THỐNG KÊ CÂN BẰNG & PHÂN PHỐI                                  [~400]
// ═════════════════════════════════════════════════════════════════════════════
function genBalanceAlgos() {
    const algos = [];
    for (const window of [10,15,20,30,50,80,100]) {
        for (const minDiff of [0.08,0.10,0.12,0.15,0.20]) {
            for (const invert of [false,true]) {  // invert=true: đoán theo bên nhiều hơn (vẫn tiếp tục thắng)
                algos.push({
                    name: `balance_w${window}_d${minDiff}_${invert?'inv':'nrm'}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < 10) return null;
                        const tai = h.filter(s => s.result === 'TAI').length;
                        const xiu = h.length - tai;
                        const diffRate = Math.abs(tai - xiu) / h.length;
                        if (diffRate < minDiff) return null;
                        let pred = tai < xiu ? 'TAI' : 'XIU';    // cân bằng về
                        if (invert) pred = pred === 'TAI' ? 'XIU' : 'TAI';  // theo đà
                        const conf = Math.min(74, 50 + diffRate * 80);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 4: PHÂN TÍCH ID & HASH MD5                                         [~300]
// ═════════════════════════════════════════════════════════════════════════════
function genIdAlgos() {
    const algos = [];
    for (const window of [50,100,200,500]) {
        for (const mod of [2,3,4,5,7,10]) {
            for (const minRate of [0.55,0.58,0.62]) {
                algos.push({
                    name: `id_mod${mod}_w${window}_r${minRate}`,
                    fn: (hist, nextIdNum) => {
                        const h = hist.slice(0, window);
                        if (h.length < 20) return null;
                        const rem = nextIdNum % mod;
                        const same = h.filter(s => s.id_num % mod === rem);
                        if (same.length < 10) return null;
                        const tai = same.filter(s => s.result === 'TAI').length;
                        const rate = Math.max(tai, same.length - tai) / same.length;
                        if (rate < minRate) return null;
                        const pred = tai >= same.length / 2 ? 'TAI' : 'XIU';
                        const conf = Math.min(75, 50 + rate * 30);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

function genMd5Algos() {
    const algos = [];
    for (const prefixLen of [2,3,4,5,6,8]) {
        for (const minSamples of [3,5,8]) {
            for (const minRate of [0.55,0.60,0.65]) {
                algos.push({
                    name: `md5_pre${prefixLen}_n${minSamples}_r${minRate}`,
                    fn: (hist) => {
                        const latest = hist[0];
                        if (!latest?.md5 || latest.md5.length < prefixLen) return null;
                        const prefix = latest.md5.slice(0, prefixLen);
                        const matches = hist.slice(1).filter(s => s.md5?.startsWith(prefix));
                        if (matches.length < minSamples) return null;
                        const tai = matches.filter(s => s.result === 'TAI').length;
                        const rate = Math.max(tai, matches.length - tai) / matches.length;
                        if (rate < minRate) return null;
                        const pred = tai >= matches.length / 2 ? 'TAI' : 'XIU';
                        const conf = Math.min(85, 50 + rate * 40 + prefixLen);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 5: ENTROPY & PHƯƠNG SAI                                            [~300]
// ═════════════════════════════════════════════════════════════════════════════
function genEntropyAlgos() {
    const algos = [];
    for (const window of [8,10,15,20,30]) {
        for (const maxEnt of [1.5,1.6,1.8,1.9]) {
            for (const order of [1,2,3]) {
                algos.push({
                    name: `entropy_w${window}_e${maxEnt}_o${order}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < 6) return null;
                        const res = h.map(s => s.result);
                        // Đếm chuyển tiếp bậc order
                        const transMap = {};
                        for (let i = order; i < res.length; i++) {
                            const key = res.slice(i-order, i).join('');
                            if (!transMap[key]) transMap[key] = { TAI:0, XIU:0 };
                            transMap[key][res[i]]++;
                        }
                        // Tính entropy Shannon
                        const total = res.length - order;
                        if (total < 3) return null;
                        let entropy = 0;
                        for (const entry of Object.values(transMap)) {
                            const n = entry.TAI + entry.XIU;
                            if (n === 0) continue;
                            const p = n / total;
                            entropy -= p * Math.log2(p + 1e-10);
                        }
                        if (entropy > maxEnt) return null;
                        // Dự đoán theo trạng thái hiện tại
                        const curKey = res.slice(0, order).join('');
                        const cur = transMap[curKey];
                        if (!cur || (cur.TAI + cur.XIU) < 2) return null;
                        const pred = cur.TAI >= cur.XIU ? 'TAI' : 'XIU';
                        const conf = Math.min(72, 52 + (maxEnt - entropy) * 10);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

function genVarianceAlgos() {
    const algos = [];
    for (const window of [10,15,20,30,50]) {
        for (const maxVar of [0.18,0.20,0.22,0.24,0.25]) {
            for (const invert of [false,true]) {
                algos.push({
                    name: `variance_w${window}_v${maxVar}_${invert?'inv':'nrm'}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window);
                        if (h.length < 10) return null;
                        const vals = h.map(s => s.result === 'TAI' ? 1 : 0);
                        const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
                        const variance = vals.reduce((a,v)=>a+(v-mean)**2,0)/vals.length;
                        if (variance > maxVar) return null;
                        const tai = vals.filter(v=>v===1).length;
                        let pred = tai >= vals.length/2 ? 'TAI' : 'XIU';
                        if (invert) pred = pred === 'TAI' ? 'XIU' : 'TAI';
                        const conf = Math.min(72, 52 + (maxVar - variance) * 80);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 6: PHÂN TÍCH TỔNG XÚC XẮC                                         [~400]
// ═════════════════════════════════════════════════════════════════════════════
function genDiceSumAlgos() {
    const algos = [];
    // Phân vùng tổng (3-18): tài = 11-18, xỉu = 3-10
    // Phân tích xu hướng tổng cao/thấp
    for (const window of [10,20,30,50]) {
        for (const zoneThres of [9,10,11,12]) {          // ngưỡng cao/thấp
            for (const minDiff of [0.10,0.12,0.15]) {
                algos.push({
                    name: `dicesum_zone_w${window}_z${zoneThres}_d${minDiff}`,
                    fn: (hist) => {
                        const h = hist.slice(0, window).filter(s => s.diceSum > 0);
                        if (h.length < 8) return null;
                        const high = h.filter(s => s.diceSum > zoneThres).length;
                        const rate  = high / h.length;
                        const diffRate = Math.abs(rate - 0.5);
                        if (diffRate < minDiff) return null;
                        const pred = rate > 0.5 ? 'TAI' : 'XIU';
                        const conf = Math.min(74, 50 + diffRate * 60);
                        return { pred, conf };
                    }
                });
            }
        }
    }
    // Phân tích xu hướng tổng sau chuỗi tài/xỉu dài
    for (const streakMin of [3,4,5]) {
        for (const window of [20,50,100]) {
            algos.push({
                name: `dicesum_afterstreak_w${window}_s${streakMin}`,
                fn: (hist) => {
                    const h = hist.slice(0, window).filter(s => s.diceSum > 0);
                    if (h.length < 10) return null;
                    // Tìm các vị trí sau chuỗi >= streakMin
                    const events = [];
                    let i = 0;
                    while (i < h.length - streakMin) {
                        const cur = h[i].result;
                        let len = 1;
                        while (i + len < h.length && h[i+len].result === cur) len++;
                        if (len >= streakMin && i > 0) {
                            events.push({ after: h[i-1].result, streak: cur });
                        }
                        i += len;
                    }
                    if (events.length < 4) return null;
                    const last   = h[0].result;
                    let streak   = 1;
                    for (let j = 1; j < h.length; j++) {
                        if (h[j].result === last) streak++;
                        else break;
                    }
                    if (streak < streakMin) return null;
                    const relevant = events.filter(e => e.streak === last);
                    if (relevant.length < 3) return null;
                    const tai = relevant.filter(e => e.after === 'TAI').length;
                    const rate = Math.max(tai, relevant.length - tai) / relevant.length;
                    if (rate < 0.6) return null;
                    const pred = tai >= relevant.length / 2 ? 'TAI' : 'XIU';
                    return { pred, conf: Math.min(75, 50 + rate * 35) };
                }
            });
        }
    }
    // Phân tích trung bình tổng di chuyển
    for (const window of [5,10,15,20]) {
        for (const thres of [10,11,12]) {
            algos.push({
                name: `dicesum_mavg_w${window}_t${thres}`,
                fn: (hist) => {
                    const h = hist.slice(0, window).filter(s => s.diceSum > 0);
                    if (h.length < 5) return null;
                    const avg = h.reduce((a,s)=>a+s.diceSum,0)/h.length;
                    const pred = avg > thres ? 'TAI' : 'XIU';
                    const conf = Math.min(70, 52 + Math.abs(avg - thres) * 3);
                    return { pred, conf };
                }
            });
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 7: CẦU ĐẶC BIỆT (1-1-2, 1-2-1, 2-1-1, 3-3-3...)                 [~500]
// ═════════════════════════════════════════════════════════════════════════════
function genPatternAlgos() {
    const algos = [];

    // Pattern cụ thể: chuỗi lặp 2+
    const patterns = [
        [2,2],   // TTXX hay XXTТ
        [1,1],   // TX hay XT
        [3,3],
        [2,1,2],
        [1,2,1],
        [3,1],
        [1,3],
        [2,3],
        [3,2],
        [4,1],
        [1,4],
    ];
    for (const pattern of patterns) {
        algos.push({
            name: `pattern_${pattern.join('-')}_follow`,
            fn: (hist) => {
                const totalLen = pattern.reduce((a,b)=>a+b,0);
                if (hist.length < totalLen + 2) return null;
                // Kiểm tra pattern khớp với lịch sử
                let pos = 0;
                const expected = [];
                const starts = ['TAI','XIU'];
                for (const s of starts) {
                    pos = 0;
                    const seq = [];
                    let cur = s;
                    for (const len of pattern) {
                        for (let k = 0; k < len; k++) seq.push(cur);
                        cur = cur === 'TAI' ? 'XIU' : 'TAI';
                    }
                    // So sánh seq với hist
                    const match = seq.every((v, i) => hist[i]?.result === v);
                    if (match) {
                        // Dự đoán ký tự tiếp theo của pattern
                        return { pred: cur, conf: 62 };
                    }
                }
                return null;
            }
        });
    }

    // Cầu xen kẽ bất quy tắc: phân tích pattern 5-8 phiên gần nhất
    for (const lookback of [5,6,7,8]) {
        algos.push({
            name: `pattern_ngramfreq_l${lookback}`,
            fn: (hist) => {
                if (hist.length < lookback * 3) return null;
                const allRes = hist.map(s => s.result);
                // Tìm n-gram của lookback phiên gần nhất trong lịch sử
                const query = allRes.slice(0, lookback).join('|');
                let matchAfter = { TAI:0, XIU:0 };
                for (let i = lookback; i < allRes.length; i++) {
                    const seg = allRes.slice(i-lookback, i).join('|');
                    if (seg === query) matchAfter[allRes[i]]++;
                }
                const total = matchAfter.TAI + matchAfter.XIU;
                if (total < 3) return null;
                const win  = Math.max(matchAfter.TAI, matchAfter.XIU);
                const rate = win / total;
                if (rate < 0.6) return null;
                const pred = matchAfter.TAI >= matchAfter.XIU ? 'TAI' : 'XIU';
                return { pred, conf: Math.min(84, 50 + rate * 40) };
            }
        });
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 8: PHÂN TÍCH THỜI GIAN / PHIÊN CHẴN LẺ                           [~300]
// ═════════════════════════════════════════════════════════════════════════════
function genTemporalAlgos() {
    const algos = [];
    // Mỗi N phiên gần đây có xu hướng nào
    for (const bucketSize of [5,10,20,50]) {
        for (const numBuckets of [2,3,4]) {
            algos.push({
                name: `temporal_b${bucketSize}_n${numBuckets}`,
                fn: (hist) => {
                    if (hist.length < bucketSize * numBuckets) return null;
                    // Tính tỉ lệ tài trong từng bucket
                    const rates = [];
                    for (let i = 0; i < numBuckets; i++) {
                        const bucket = hist.slice(i*bucketSize, (i+1)*bucketSize);
                        const tai = bucket.filter(s=>s.result==='TAI').length;
                        rates.push(tai/bucket.length);
                    }
                    // Xu hướng đang tăng hay giảm?
                    const trend = rates[0] - rates[numBuckets-1];
                    if (Math.abs(trend) < 0.1) return null;
                    const pred = trend > 0 ? 'TAI' : 'XIU';  // đang tăng tài → tiếp tài
                    const conf = Math.min(70, 52 + Math.abs(trend) * 30);
                    return { pred, conf };
                }
            });
        }
    }
    // Phân tích chẵn/lẻ phiên
    for (const window of [50,100,200]) {
        for (const minRate of [0.56,0.60]) {
            algos.push({
                name: `even_odd_w${window}_r${minRate}`,
                fn: (hist, nextIdNum) => {
                    const h = hist.slice(0, window);
                    if (h.length < 20) return null;
                    const isEven = nextIdNum % 2 === 0;
                    const relevant = h.filter(s => (s.id_num%2===0) === isEven);
                    if (relevant.length < 10) return null;
                    const tai = relevant.filter(s=>s.result==='TAI').length;
                    const rate = Math.max(tai, relevant.length-tai)/relevant.length;
                    if (rate < minRate) return null;
                    return { pred: tai>=relevant.length/2?'TAI':'XIU', conf: Math.min(72, 50+rate*25) };
                }
            });
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 9: ĐẢO NGƯỢC (BẺ CẦU THÔNG MINH)                                 [~300]
// ═════════════════════════════════════════════════════════════════════════════
function genReversalAlgos() {
    const algos = [];
    // Phát hiện khi chuỗi đã quá dài → bẻ
    for (const breakThreshold of [5,6,7,8,9,10]) {
        for (const histWindow of [50,100,200]) {
            for (const minBreakRate of [0.5,0.55,0.60]) {
                algos.push({
                    name: `reversal_t${breakThreshold}_w${histWindow}_r${minBreakRate}`,
                    fn: (hist) => {
                        const h = hist.slice(0, histWindow);
                        if (h.length < 20) return null;
                        const cur = h[0].result;
                        let streak = 1;
                        for (let i = 1; i < h.length; i++) {
                            if (h[i].result === cur) streak++;
                            else break;
                        }
                        if (streak < breakThreshold) return null;
                        // Kiểm tra lịch sử: sau chuỗi >= threshold thì bẻ bao nhiêu lần?
                        let breaks = 0, totals = 0;
                        let j = streak;
                        while (j < h.length - 1) {
                            let c = h[j].result;
                            let l = 1;
                            while (j+l < h.length && h[j+l].result === c) l++;
                            if (l >= breakThreshold) {
                                totals++;
                                if (j > 0 && h[j-1].result !== c) breaks++;
                            }
                            j += l;
                        }
                        const rate = totals > 2 ? breaks/totals : minBreakRate;
                        if (rate < minBreakRate) return null;
                        const opp = cur === 'TAI' ? 'XIU' : 'TAI';
                        return { pred: opp, conf: Math.min(80, 50 + rate * 40) };
                    }
                });
            }
        }
    }
    // Bẻ khi cầu pingpong bị phá
    for (const ppLen of [4,5,6]) {
        algos.push({
            name: `reversal_pp_break_${ppLen}`,
            fn: (hist) => {
                if (hist.length < ppLen + 2) return null;
                // ppLen phiên trước là pingpong, phiên cuối phá vỡ
                let wasPP = true;
                for (let i = 1; i < ppLen+1; i++) {
                    if (!hist[i] || !hist[i-1]) { wasPP=false; break; }
                    if (hist[i].result === hist[i-1].result) { wasPP=false; break; }
                }
                if (!wasPP) return null;
                // Phiên hiện tại giống phiên trước (phá pingpong) → tiếp theo giống
                if (hist[0].result === hist[1].result) {
                    return { pred: hist[0].result, conf: 63 };
                }
                return null;
            }
        });
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// NHÓM 10: ĐA KHUNG + TỔ HỢP ĐA CHIỀU                                   [~300]
// ═════════════════════════════════════════════════════════════════════════════
function genMultiframeAlgos() {
    const algos = [];
    const frames = [[5,20],[10,50],[20,100],[5,50],[10,100]];
    for (const [short, long] of frames) {
        for (const diffThres of [0.10,0.15,0.20]) {
            algos.push({
                name: `multiframe_s${short}_l${long}_d${diffThres}`,
                fn: (hist) => {
                    if (hist.length < long) return null;
                    const s = hist.slice(0,short);
                    const l = hist.slice(0,long);
                    const rS = s.filter(x=>x.result==='TAI').length/s.length;
                    const rL = l.filter(x=>x.result==='TAI').length/l.length;
                    const diff = rS - rL;
                    if (Math.abs(diff) < diffThres) return null;
                    // Ngắn hạn lệch nhiều khỏi dài hạn → hồi về
                    const pred = diff > 0 ? 'XIU' : 'TAI';
                    const conf = Math.min(73, 52 + Math.abs(diff) * 50);
                    return { pred, conf };
                }
            });
        }
    }
    return algos;
}

// ═════════════════════════════════════════════════════════════════════════════
// TẠO 5000 THUẬT TOÁN
// ═════════════════════════════════════════════════════════════════════════════
console.log('[Engine] Building 5000 algorithms...');
const ALL_ALGOS = [
    ...genStreakAlgos(),        // ~189 algos
    ...genBreakStreakAlgos(),   // ~240 algos
    ...genPingpongAlgos(),      // ~120 algos
    ...genMarkovAlgos(),        // ~1280 algos
    ...genBalanceAlgos(),       // ~210 algos
    ...genIdAlgos(),            // ~180 algos
    ...genMd5Algos(),           // ~126 algos
    ...genEntropyAlgos(),       // ~300 algos
    ...genVarianceAlgos(),      // ~210 algos
    ...genDiceSumAlgos(),       // ~450 algos
    ...genPatternAlgos(),       // ~170 algos
    ...genTemporalAlgos(),      // ~180 algos
    ...genReversalAlgos(),      // ~300 algos
    ...genMultiframeAlgos(),    // ~45 algos
];
console.log(`[Engine] Built ${ALL_ALGOS.length} algorithms`);

// Trọng số động cho mỗi thuật toán
const algoWeights = {};
const algoHistory2 = {};
const WEIGHT_WINDOW = 30;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 5.0;

ALL_ALGOS.forEach(a => {
    algoWeights[a.name]  = 1.0;
    algoHistory2[a.name] = [];
});

function updateAlgoWeight(name, correct) {
    const hist = algoHistory2[name];
    hist.unshift(correct ? 1 : 0);
    if (hist.length > WEIGHT_WINDOW) hist.pop();
    if (hist.length >= 5) {
        const acc = hist.reduce((a,b)=>a+b,0)/hist.length;
        // acc=0.5→weight=0.1, acc=0.8→weight=5.0
        const w = WEIGHT_MIN + (WEIGHT_MAX-WEIGHT_MIN) * Math.max(0, (acc-0.5)/0.3);
        algoWeights[name] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// BỂ CẦU SIÊU TỰ ĐỘNG (Multi-Level Auto Breaker)
// ═════════════════════════════════════════════════════════════════════════════
const BREAK_WINDOWS = [3,5,7,10,15,20];   // nhiều cửa sổ
const BREAK_THRESH  = 0.30;
const RECOVER_THRESH = 0.65;

let recentOutcomes = [];          // true/false
let autoBreaker = {
    active: false,
    level:  0,         // 0=off, 1=soft, 2=hard
    streak: 0,         // chuỗi sai liên tiếp hiện tại
    totalFlips: 0,
};

function recordOutcome(correct) {
    recentOutcomes.unshift(correct);
    if (recentOutcomes.length > 50) recentOutcomes.pop();
    _evaluateBreaker();
}

function _evaluateBreaker() {
    const w10 = recentOutcomes.slice(0,10);
    const w5  = recentOutcomes.slice(0,5);
    if (w10.length < 5) return;

    const acc10 = w10.filter(Boolean).length/w10.length;
    const acc5  = w5.filter(Boolean).length/w5.length;

    // Kích hoạt HARD breaker: sai liên tiếp >= 4, hoặc acc10 < 25%
    const consec = _consecWrong();
    if (consec >= 4 || acc10 < 0.25) {
        if (autoBreaker.level !== 2) {
            autoBreaker.level  = 2;
            autoBreaker.active = true;
            console.log(`🔥🔥 HARD BREAKER: ${consec} sai liên tiếp, acc10=${(acc10*100).toFixed(0)}%`);
        }
        return;
    }
    // Kích hoạt SOFT breaker: acc5 < 30%
    if (acc5 < 0.30) {
        if (autoBreaker.level === 0) {
            autoBreaker.level  = 1;
            autoBreaker.active = true;
            console.log(`⚡ SOFT BREAKER: acc5=${(acc5*100).toFixed(0)}%`);
        }
        return;
    }
    // Hồi phục
    if (autoBreaker.active && acc10 >= RECOVER_THRESH) {
        autoBreaker.level  = 0;
        autoBreaker.active = false;
        console.log(`✅ BREAKER OFF: acc10=${(acc10*100).toFixed(0)}%`);
    }
}

function _consecWrong() {
    let n = 0;
    for (const r of recentOutcomes) { if (!r) n++; else break; }
    return n;
}

function applyBreaker(pred, conf) {
    if (!autoBreaker.active) return { pred, conf };
    if (autoBreaker.level === 2) {
        const newPred = pred === 'TAI' ? 'XIU' : 'TAI';
        autoBreaker.totalFlips++;
        return { pred: newPred, conf: Math.min(82, conf * 0.85) };
    }
    if (autoBreaker.level === 1) {
        const newPred = pred === 'TAI' ? 'XIU' : 'TAI';
        autoBreaker.totalFlips++;
        return { pred: newPred, conf: Math.min(75, conf * 0.80) };
    }
    return { pred, conf };
}

// ═════════════════════════════════════════════════════════════════════════════
// HÀM CHÍNH: CHẠY 5000 THUẬT TOÁN & TỔ HỢP
// ═════════════════════════════════════════════════════════════════════════════
let lastPredResult = null;

function omegaPredict5000(sessions, nextIdNum) {
    if (sessions.length < 3) return { prediction:'TAI', confidence:50, method:'Thiếu dữ liệu', breakdown:[] };

    let scoreTai = 0, scoreXiu = 0;
    let activeCnt = 0;
    const topAlgos = [];   // top algo để hiển thị
    const algoSignals = {};  // tên -> {pred,conf}

    for (const algo of ALL_ALGOS) {
        let res = null;
        try { res = algo.fn(sessions, nextIdNum); } catch (_) {}
        if (!res || !res.pred || res.conf <= 0) continue;

        const w = algoWeights[algo.name] * (res.conf / 100);
        if (res.pred === 'TAI') scoreTai += w;
        else                    scoreXiu += w;
        activeCnt++;
        algoSignals[algo.name] = res;

        if (topAlgos.length < 20) topAlgos.push({ name: algo.name, ...res, weight: algoWeights[algo.name] });
    }

    const totalScore = scoreTai + scoreXiu;
    let finalPred, finalConf, method;

    if (totalScore === 0) {
        // Fallback: tỉ lệ gần nhất
        const n  = Math.min(sessions.length, 50);
        const tai = sessions.slice(0,n).filter(s=>s.result==='TAI').length;
        finalPred = tai >= n/2 ? 'TAI' : 'XIU';
        finalConf = 50;
        method = 'Fallback thống kê';
    } else {
        finalPred = scoreTai >= scoreXiu ? 'TAI' : 'XIU';
        const winRate = Math.max(scoreTai, scoreXiu) / totalScore;
        finalConf = Math.min(95, Math.max(50, 50 + (winRate-0.5)*100));
        const domCnt = topAlgos.filter(a=>a.pred===finalPred).length;
        const opp    = topAlgos.length - domCnt;
        method = domCnt > opp * 2
            ? `Đồng thuận ${domCnt}/${topAlgos.length} (${activeCnt}/5000 active)`
            : `Weighted vote ${domCnt}v${opp} (${activeCnt}/5000 active)`;
    }

    // Bẻ tự động
    const broke = applyBreaker(finalPred, finalConf);
    if (broke.pred !== finalPred) method = `[AUTO BREAK Lv${autoBreaker.level}] ${method}`;
    finalPred = broke.pred;
    finalConf = broke.conf;

    return { prediction: finalPred, confidence: Math.round(finalConf), method, topAlgos, activeCnt, algoSignals, scoreTai, scoreXiu };
}

// ═════════════════════════════════════════════════════════════════════════════
// CẬP NHẬT TRỌNG SỐ SAU KHI CÓ KẾT QUẢ
// ═════════════════════════════════════════════════════════════════════════════
function learnFromResult(sessionResult, algoSignals) {
    for (const [name, sig] of Object.entries(algoSignals)) {
        if (sig && sig.pred) updateAlgoWeight(name, sig.pred === sessionResult);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// CẬP NHẬT DỰ ĐOÁN CHÍNH
// ═════════════════════════════════════════════════════════════════════════════
function updatePredictions() {
    if (sessions.length === 0) return;
    const latest    = sessions[0];
    const nextIdNum = latest.id_num + 1;

    // Học từ kết quả đã có
    for (const sess of sessions.slice(0, 30)) {
        const pred = predictions.find(p => p.predictedId === sess.id_num && p.correct === null);
        if (pred) {
            pred.actual  = sess.result;
            pred.correct = pred.predicted === sess.result;
            recordOutcome(pred.correct);
            if (pred.algoSignals) learnFromResult(sess.result, pred.algoSignals);
            console.log(`[Learn] #${sess.id_num}: ${pred.correct ? '✅' : '❌'} (pred=${pred.predicted} actual=${sess.result})`);
        }
    }

    // Tạo/cập nhật dự đoán mới
    const { prediction, confidence, method, topAlgos, activeCnt, algoSignals, scoreTai, scoreXiu } = omegaPredict5000(sessions, nextIdNum);
    const existing = predictions.find(p => p.predictedId === nextIdNum);
    const entry = {
        predictedId: nextIdNum, predicted: prediction, confidence, method,
        topAlgos, activeCnt, algoSignals, scoreTai, scoreXiu,
        actual: null, correct: null,
        breakerActive: autoBreaker.active, breakerLevel: autoBreaker.level,
        timestamp: Date.now()
    };
    if (!existing) predictions.unshift(entry);
    else if (existing.correct === null) Object.assign(existing, entry);

    if (predictions.length > MAX_HISTORY) predictions = predictions.slice(0, MAX_HISTORY);
    lastPredResult = entry;
    saveCache();
    console.log(`[Omega] #${nextIdNum}: ${prediction==='TAI'?'🔴':'⚪'} ${prediction} ${confidence}% | ${method}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// FETCH DỮ LIỆU THẬT TỰ ĐỘNG
// ═════════════════════════════════════════════════════════════════════════════
async function fetchRealData(retry = true) {
    if (isFetching) return false;
    isFetching = true;
    try {
        console.log(`[${new Date().toISOString()}] Fetching ${API_URL}...`);
        const resp = await axios.get(API_URL, {
            timeout: 20000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Omega/5.0)' }
        });
        const parsed = tryParseSessions(resp.data);
        if (parsed.length === 0) throw new Error('No sessions parsed from API');

        let added = 0;
        const existingIds = new Set(sessions.map(s => s.id));
        for (const ns of parsed) {
            if (!existingIds.has(ns.id)) { sessions.push(ns); added++; }
        }
        sessions.sort((a,b) => b.id_num - a.id_num);
        if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
        console.log(`[Fetch] +${added} new sessions. Total: ${sessions.length}`);

        usingMock = false;
        lastFetchError = null;
        updatePredictions();
        saveCache();
        isFetching = false;
        return true;
    } catch (err) {
        console.error('[Fetch] Error:', err.message);
        lastFetchError = err.message;
        isFetching = false;
        if (retry) setTimeout(() => fetchRealData(false), RETRY_DELAY);
        return false;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// KHỞI TẠO
// ═════════════════════════════════════════════════════════════════════════════
loadCache();
if (sessions.length === 0) {
    sessions  = generateMockSessions();
    usingMock = true;
    updatePredictions();
    saveCache();
    console.log('[Init] Using mock data until real API responds.');
}
// Cập nhật ngay lần đầu + định kỳ 15 giây
setTimeout(() => fetchRealData(), 1000);
setInterval(() => fetchRealData(), FETCH_INTERVAL);

// ═════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '10mb' }));

// ─── /predict_text ───────────────────────────────────────────────────────────
app.get('/predict_text', (req, res) => {
    if (sessions.length === 0) return res.send('Chưa có dữ liệu.');
    const latest  = sessions[0];
    const nextId  = latest.id_num + 1;
    const pred    = predictions.find(p => p.predictedId === nextId);
    const SEP     = '═'.repeat(50);
    const sep2    = '─'.repeat(50);

    // Xúc xắc & tổng thật từ API
    const diceStr  = latest.dice?.length === 3 ? latest.dice.join(' - ') : '—';
    const tongStr  = latest.diceSum > 0 ? `${latest.diceSum}` : '—';

    const chot     = pred ? (pred.predicted === 'TAI' ? '🔴 TÀI' : '⚪ XỈU') : '❓ Chưa có';
    const conf     = pred?.confidence ?? 0;
    const barFill  = Math.round(conf/100*25);
    const bar      = `[${'█'.repeat(barFill)}${'░'.repeat(25-barFill)}] ${conf}%`;

    // Breaker status
    const brkLine  = autoBreaker.active
        ? `\n⚡ AUTO BREAKER LV${autoBreaker.level} ĐANG HOẠT ĐỘNG (đã lật ${autoBreaker.totalFlips} lần)\n`
        : '';

    // Thống kê
    const done     = predictions.filter(p=>p.correct!==null);
    const correct  = done.filter(p=>p.correct).length;
    const acc      = done.length ? (correct/done.length*100).toFixed(1) : '—';

    // Lịch sử gần nhất
    let histLines = `\n📜 LỊCH SỬ 30 PHIÊN GẦN NHẤT\n${sep2}\n`;
    histLines += `${'Phiên'.padEnd(10)} ${'KQ'.padEnd(8)} ${'Xúc xắc'.padEnd(12)} ${'Tổng'.padEnd(6)} MD5\n`;
    histLines += sep2 + '\n';
    for (let i = 0; i < Math.min(sessions.length, 30); i++) {
        const s     = sessions[i];
        const kq    = s.result === 'TAI' ? '🔴 Tài  ' : '⚪ Xỉu  ';
        const ds    = s.dice?.length === 3 ? s.dice.join('-') : '—';
        const tong  = s.diceSum > 0 ? String(s.diceSum) : '—';
        const md5s  = s.md5 ? s.md5.slice(0,8) : '—';
        histLines  += `${'#'+s.id_num}${' '.repeat(Math.max(0,10-String('#'+s.id_num).length))} ${kq} ${ds.padEnd(12)} ${tong.padEnd(6)} ${md5s}\n`;
    }

    // Top thuật toán
    let topLine = '';
    if (pred?.topAlgos?.length) {
        topLine = `\n🔬 TOP THUẬT TOÁN (${pred.activeCnt ?? '?'}/5000 hoạt động)\n${sep2}\n`;
        for (const a of pred.topAlgos.slice(0,12)) {
            const icon = a.pred === 'TAI' ? '🔴' : '⚪';
            topLine += `  ${icon} ${a.pred} ${String(a.conf.toFixed(0)+'%').padEnd(6)} w=${a.weight?.toFixed(2)??'1.00'} | ${a.name}\n`;
        }
    }

    const out = [
        SEP,
        `🔮 OMEGA v5.0 — DỰ ĐOÁN TÀI XỈU (5000 THUẬT TOÁN)`,
        SEP,
        `📌 Phiên hiện tại : #${latest.id_num}  →  ${latest.result === 'TAI' ? '🔴 TÀI' : '⚪ XỈU'}`,
        `🎲 Xúc xắc        : ${diceStr}`,
        `🔢 Tổng           : ${tongStr}`,
        `🔑 MD5            : ${latest.md5 ? latest.md5.slice(0,20)+'...' : '—'}`,
        brkLine,
        SEP,
        `✨ CHỐT PHIÊN #${nextId} : ${chot}`,
        `📊 Độ tin cậy     : ${bar}`,
        `🧠 Phương pháp    : ${pred?.method ?? 'Chưa có'}`,
        sep2,
        topLine,
        histLines,
        sep2,
        `📊 THỐNG KÊ: Đúng ${correct}/${done.length} (${acc}%) | Lật ${autoBreaker.totalFlips} lần`,
        SEP,
        `⏱ ${new Date().toLocaleString('vi-VN')} | Cập nhật ${FETCH_INTERVAL/1000}s/lần`,
        SEP
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(out);
});

// ─── /predict (JSON) ─────────────────────────────────────────────────────────
app.get('/predict', (req, res) => {
    if (sessions.length === 0) return res.json({ error: 'No data' });
    const latest   = sessions[0];
    const nextId   = latest.id_num + 1;
    const pred     = predictions.find(p => p.predictedId === nextId);
    const done     = predictions.filter(p => p.correct !== null);
    const correct  = done.filter(p => p.correct).length;

    res.json({
        status:        'success',
        using_mock:    usingMock,
        last_error:    lastFetchError,
        breaker: {
            active: autoBreaker.active,
            level:  autoBreaker.level,
            total_flips: autoBreaker.totalFlips
        },
        phien_hien_tai: {
            id:       latest.id_num,
            ket_qua:  latest.result === 'TAI' ? 'Tài' : 'Xỉu',
            xuc_xac:  latest.dice?.length === 3 ? latest.dice.join('-') : null,
            tong:     latest.diceSum > 0 ? latest.diceSum : null,
            md5:      latest.md5 || null
        },
        du_doan_phien_tiep: {
            phien:         nextId,
            chot:          pred ? (pred.predicted === 'TAI' ? 'Tài' : 'Xỉu') : 'Chưa có',
            do_tin_cay:    pred?.confidence ?? 0,
            phuong_phap:   pred?.method ?? 'Chưa xác định',
            active_algos:  pred?.activeCnt ?? 0,
            score_tai:     pred?.scoreTai?.toFixed(2) ?? '0',
            score_xiu:     pred?.scoreXiu?.toFixed(2) ?? '0',
            top_algos:     pred?.topAlgos?.slice(0,10) ?? []
        },
        thong_ke: {
            tong_da_danh_gia: done.length,
            dung:   correct,
            sai:    done.length - correct,
            ty_le:  done.length ? `${(correct/done.length*100).toFixed(1)}%` : '—'
        }
    });
});

// ─── /sessions (xem dữ liệu thô) ─────────────────────────────────────────────
app.get('/sessions', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ total: sessions.length, sessions: sessions.slice(0, limit) });
});

// ─── /stats (thống kê chi tiết) ───────────────────────────────────────────────
app.get('/stats', (req, res) => {
    const done    = predictions.filter(p => p.correct !== null);
    const correct = done.filter(p => p.correct).length;
    const last20  = recentOutcomes.slice(0,20);
    res.json({
        sessions_total: sessions.length,
        predictions_total: predictions.length,
        accuracy: done.length ? (correct/done.length*100).toFixed(1)+'%' : '—',
        recent_20: {
            correct: last20.filter(Boolean).length,
            total: last20.length,
            rate: last20.length ? (last20.filter(Boolean).length/last20.length*100).toFixed(1)+'%' : '—'
        },
        breaker: autoBreaker,
        algo_count: ALL_ALGOS.length,
        using_mock: usingMock,
        fetch_interval_sec: FETCH_INTERVAL/1000,
        last_fetch_error: lastFetchError
    });
});

// ─── /force_fetch ─────────────────────────────────────────────────────────────
app.post('/force_fetch', async (req, res) => {
    const ok = await fetchRealData(false);
    res.json({ fetched: ok, sessions: sessions.length, using_mock: usingMock, error: lastFetchError });
});

// ─── /fetch (POST dữ liệu ngoài) ──────────────────────────────────────────────
app.post('/fetch', async (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'Missing data' });
    const parsed = tryParseSessions(data);
    if (!parsed.length) return res.status(400).json({ error: 'Cannot parse data' });
    const existingIds = new Set(sessions.map(s=>s.id));
    let added = 0;
    for (const ns of parsed) if (!existingIds.has(ns.id)) { sessions.push(ns); added++; }
    sessions.sort((a,b)=>b.id_num-a.id_num);
    if (sessions.length > MAX_HISTORY) sessions = sessions.slice(0, MAX_HISTORY);
    usingMock = false;
    updatePredictions();
    saveCache();
    res.json({ status: 'ok', added, total: sessions.length });
});

// ─── /health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok', uptime: process.uptime().toFixed(0)+'s',
        sessions: sessions.length, predictions: predictions.length,
        using_mock: usingMock, breaker: autoBreaker,
        algo_count: ALL_ALGOS.length, last_error: lastFetchError
    });
});

// ─── / (trang chủ) ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        name: 'Omega Prediction Engine v5.0',
        endpoints: {
            '/predict_text': 'GET - Dự đoán dạng text (đẹp)',
            '/predict':      'GET - Dự đoán dạng JSON',
            '/sessions':     'GET - Xem dữ liệu phiên (limit=N)',
            '/stats':        'GET - Thống kê chi tiết',
            '/force_fetch':  'POST - Fetch dữ liệu ngay',
            '/fetch':        'POST - Nộp dữ liệu thủ công {data:[...]}',
            '/health':       'GET - Sức khỏe server'
        },
        algo_count: ALL_ALGOS.length,
        fetch_interval: `${FETCH_INTERVAL/1000}s`
    });
});

// ─── KHỞI ĐỘNG ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Omega v5.0 running on port ${PORT}`);
    console.log(`📝 text UI : http://localhost:${PORT}/predict_text`);
    console.log(`📊 JSON    : http://localhost:${PORT}/predict`);
    console.log(`📈 stats   : http://localhost:${PORT}/stats`);
    console.log(`🔢 Thuật toán: ${ALL_ALGOS.length}`);
    console.log(`⏱  Auto-update: ${FETCH_INTERVAL/1000}s\n`);
});