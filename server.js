/**
 * Ito Online Server - Ver.2.0.0
 * * 核心功能：
 * 1. WebSocket (Socket.io) 实时通信
 * 2. 玩家状态管理 (在线/离线/旁观/重连)
 * 3. 游戏流程控制 (发牌、出牌、开牌结算)
 * 4. 预设主题库加载
 * 5. 聊天记录缓存与过滤
 * 6. 紧急重置 (带权限)
 */

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const PRESET_THEMES = require('./themes.js'); // 加载预设主题

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,  // 增加超时宽容度
    pingInterval: 25000
});

app.use(express.static(__dirname));

// --- 数据存储 ---
// players: 存储所有玩家对象，key 为 uid
// tableCards: 存储桌面上已打出的牌
// chatHistory: 存储最近的聊天记录
// gameConfig: 存储当前游戏状态 (等待/进行中/结算)、主题、模式
let players = {}; 
let tableCards = []; 
let chatHistory = []; 
let gameConfig = {
    theme: "等待设置题目...",
    status: "waiting", // 状态枚举: 'waiting', 'playing', 'revealed'
    mode: "normal" 
};

// 自动重置倒计时器 (防止所有人意外断线导致数据立即清空)
let autoResetTimer = null;

/**
 * 获取公开的桌面数据
 * @returns {Array} 包含桌面卡片信息的数组。如果未开牌，隐藏 'number' 字段防止作弊。
 */
function getPublicTableData() {
    if (gameConfig.status === 'revealed') {
        return tableCards; // 开牌后，显示所有信息
    } else {
        // 游戏进行中，数字脱敏为 null
        return tableCards.map(c => ({
            uid: c.uid,
            name: c.name,
            desc: c.desc,
            number: null 
        }));
    }
}

/**
 * 获取当前活跃玩家数
 * 活跃定义：非旁观者 (isSpectator: false) 且 在线 (online: true)
 * 用于判断是否可以开牌。
 */
function getActivePlayerCount() {
    return Object.values(players).filter(p => !p.isSpectator && p.online).length;
}

/**
 * 全局重置游戏数据
 * 用于所有玩家离开后清理内存，或管理员强制重置。
 */
function resetGameData() {
    console.log("执行全局重置...");
    players = {};
    tableCards = [];
    chatHistory = [];
    gameConfig = {
        theme: "等待设置题目...",
        status: "waiting",
        mode: "normal"
    };
}

/**
 * 发牌逻辑辅助函数
 * 只发给：在线、非旁观者、且当前手中没有牌的玩家。
 * 防止在游戏进行中修改题目导致重复发牌。
 */
function dealCardsToPlayers() {
    // 生成 1-100 随机数组并打乱
    let numbers = Array.from({length: 100}, (_, i) => i + 1);
    numbers.sort(() => Math.random() - 0.5);

    for (let uid in players) {
        const p = players[uid];
        // 仅给还没牌的活跃玩家发牌
        if (!p.isSpectator && p.online && p.card === null) {
            p.card = numbers.pop();
            p.desc = ""; // 发新牌时重置描述
            const socketId = p.socketId;
            if (socketId) {
                // 私聊发送数字
                io.to(socketId).emit('yourCard', { number: p.card, desc: "" });
            }
        }
    }
}

io.on('connection', (socket) => {
    // 有新连接时，取消自动重置倒计时 (防刷新丢失数据)
    if (autoResetTimer) {
        clearTimeout(autoResetTimer);
        autoResetTimer = null;
    }

    // --- 玩家登录/重连 ---
    socket.on('login', ({ uid, name }) => {
        let isNewUser = !players[uid];
        
        if (players[uid]) {
            // 老玩家重连：更新 socketId，标记为在线，状态保持不变
            players[uid].socketId = socket.id;
            players[uid].name = name || players[uid].name;
            players[uid].online = true; 
        } else {
            // 新玩家加入
            let isSpectator = false;
            // 如果游戏正在进行中加入，强制设为旁观者
            if (gameConfig.status === 'playing') {
                isSpectator = true;
            }

            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                card: null,
                desc: "",
                isPlayed: false, // 是否已出牌
                isSpectator: isSpectator,
                online: true,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        
        // 发送历史聊天记录 (过滤掉超过 5 小时的)
        const now = Date.now();
        chatHistory = chatHistory.filter(msg => (now - msg.timestamp) < 5 * 60 * 60 * 1000);

        // 发送初始化数据给当前玩家
        socket.emit('loginSuccess', {
            me: players[uid],
            gameConfig: gameConfig,
            tableCards: getPublicTableData(),
            chatHistory: chatHistory, 
            activePlayerCount: getActivePlayerCount()
        });
        
        // 广播更新玩家列表
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // --- 设置题目 ---
    socket.on('updateTheme', (theme) => {
        // 游戏进行中或等待中允许设置，但如果已有牌打出则禁止 (前端已校验，后端二次校验)
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);

        // 设置题目后，如果游戏已开始，则尝试发牌
        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    // --- 随机题目 ---
    socket.on('requestRandomTheme', () => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        const randomIndex = Math.floor(Math.random() * PRESET_THEMES.length);
        const rawTheme = PRESET_THEMES[randomIndex];
        const formattedTheme = `随机主题#${randomIndex + 1}：${rawTheme}`;
        
        gameConfig.theme = formattedTheme;
        io.to('gameRoom').emit('updateTheme', formattedTheme);

        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    // --- 开始游戏 (Reset 阶段) ---
    // 注意：此阶段不发牌，直到设置题目
    socket.on('startGame', (mode) => {
        tableCards = []; 
        gameConfig.status = 'playing'; 
        gameConfig.mode = mode || 'normal';
        gameConfig.theme = "请设置主题以开始发牌..."; // 重置题目提示

        // 广播更新
        io.to('gameRoom').emit('updateTheme', gameConfig.theme);
        io.to('gameRoom').emit('gameStarted', { 
            activePlayerCount: getActivePlayerCount(),
            mode: gameConfig.mode
        });

        // 重置所有玩家状态 (取消旁观者，清空手牌)
        for (let uid in players) {
            players[uid].isSpectator = false; 
            players[uid].card = null; 
            players[uid].desc = "";     
            players[uid].isPlayed = false;
            
            const socketId = players[uid].socketId;
            if (socketId && players[uid].online) {
                // 发送空数据，让前端清空手牌显示
                io.to(socketId).emit('yourCard', { number: null, desc: "" });
            }
        }

        io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // --- 紧急重置 (带管理员校验) ---
    socket.on('emergencyReset', (password) => {
        let requestPlayer = null;
        for(let uid in players) {
            if (players[uid].socketId === socket.id) {
                requestPlayer = players[uid];
                break;
            }
        }

        if (requestPlayer) {
            // 旁观者需要密码 "admin"
            if (requestPlayer.isSpectator) {
                if (password !== 'admin') {
                    socket.emit('errorMessage', '管理员密码错误，无法重置。');
                    return;
                }
            }
            // 玩家点击不需要密码 (前端已做双击确认)
            resetGameData();
            io.to('gameRoom').emit('forceReset'); // 强制前端刷新
        }
    });

    // --- 玩家操作：更新描述 ---
    socket.on('updateDesc', ({ uid, desc }) => {
        if (players[uid]) players[uid].desc = desc;
    });

    // --- 玩家操作：出牌 ---
    socket.on('playCard', ({ uid }) => {
        const p = players[uid];
        if (p && p.card && !p.isPlayed) {
            p.isPlayed = true;
            tableCards.push({
                uid: p.uid,
                name: p.name,
                desc: p.desc,
                number: p.card
            });
            
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
            io.to('gameRoom').emit('playerPlayed', uid); 
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    // --- 玩家操作：拖拽排序 ---
    socket.on('reorderCards', (newOrderIndices) => {
        if (!Array.isArray(newOrderIndices)) return;
        
        // 根据前端传来的 uid 顺序重新排列 tableCards
        const newTable = [];
        newOrderIndices.forEach(uid => {
            const card = tableCards.find(c => c.uid === uid);
            if (card) newTable.push(card);
        });

        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            // 广播新的顺序 (SortableJS 依赖此同步)
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        }
    });
    
    // --- 玩家操作：收回牌 ---
    socket.on('takeBackCard', ({uid}) => {
        const p = players[uid];
        if(p && p.isPlayed && gameConfig.status !== 'revealed') {
            p.isPlayed = false;
            tableCards = tableCards.filter(c => c.uid !== uid); // 从桌面移除
            io.to('gameRoom').emit('updateTable', getPublicTableData());
            io.to('gameRoom').emit('playerTakenBack', uid);
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    // --- 开牌结算 ---
    socket.on('revealCards', () => {
        const activeCount = getActivePlayerCount();
        // 校验：桌上牌数 >= 活跃玩家数 (且 > 0)
        if (tableCards.length < activeCount || activeCount === 0) return;

        gameConfig.status = 'revealed';
        
        // 判定是否从小到大排序
        let isSuccess = true;
        let failedIndices = [];
        
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                failedIndices.push(i); 
            }
        }
        
        io.to('gameRoom').emit('gameResult', { 
            tableCards: tableCards, // 发送带数字的数据
            isSuccess: isSuccess,
            failedIndices: failedIndices
        });
        
        // 游戏结束：全员转正，开放下一局按钮
        for (let uid in players) {
            players[uid].isSpectator = false; 
        }
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        io.to('gameRoom').emit('gameEnded');
    });

    // --- 聊天 ---
    socket.on('sendChat', ({ uid, msg }) => {
        const p = players[uid];
        if (p && msg.trim().length > 0) {
            const chatMsg = { 
                name: p.name, 
                msg: msg,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            if (chatHistory.length > 100) chatHistory.shift(); // 保留最近100条
            io.to('gameRoom').emit('chatMessage', chatMsg);
        }
    });

    // --- 断开连接 ---
    socket.on('disconnect', () => {
        // 仅标记为离线，不删除数据
        for (let uid in players) {
            if (players[uid].socketId === socket.id) {
                players[uid].online = false; 
                break;
            }
        }
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));

        // 检查房间是否空了
        const room = io.sockets.adapter.rooms.get('gameRoom');
        const numClients = room ? room.size : 0;

        // 如果空了，启动10秒倒计时清空数据
        if (numClients === 0) {
            autoResetTimer = setTimeout(() => {
                resetGameData();
            }, 10000); 
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
