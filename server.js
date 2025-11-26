const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const PRESET_THEMES = require('./themes.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(__dirname));

// --- 数据存储 ---
let players = {}; 
let tableCards = []; 
let chatHistory = []; 
let gameConfig = {
    theme: "等待设置题目...",
    status: "waiting", // 'waiting', 'playing', 'revealed', 'voting'
    mode: "normal"     // 'normal', 'double', 'wolf'
};

// 投票相关数据
let votingData = {
    round: 1,           // 1: 第一轮, 2: 平票PK轮
    votes: {},          // { voterUid: targetUid }
    tiedCandidates: []  // 平票PK时的候选人UID
};

let autoResetTimer = null;

function getPublicTableData() {
    // 只有在 'revealed' (普通模式结算) 或 'game_over' (狼人模式彻底结束) 时才显示数字
    // 注意：狼人模式进入 'voting' 阶段时，牌的数字其实已经公开了（因为是排序失败后才投票）
    // 所以只要 status 不是 playing/waiting，理论上都可以看牌
    if (gameConfig.status === 'playing' || gameConfig.status === 'waiting') {
        return tableCards.map(c => ({
            uid: c.uid,
            cardId: c.cardId,
            name: c.name,
            desc: c.desc,
            number: null 
        }));
    } else {
        return tableCards; 
    }
}

function getActivePlayerCount() {
    return Object.values(players).filter(p => !p.isSpectator && p.online).length;
}

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
    resetVotingData();
}

function resetVotingData() {
    votingData = {
        round: 1,
        votes: {},
        tiedCandidates: []
    };
}

function dealCardsToPlayers() {
    let numbers = Array.from({length: 100}, (_, i) => i + 1);
    numbers.sort(() => Math.random() - 0.5);

    // 狼人模式和普通模式发1张，双牌发2张
    const cardsPerPlayer = gameConfig.mode === 'double' ? 2 : 1;

    for (let uid in players) {
        const p = players[uid];
        if (!p.isSpectator && p.online && p.hand.length === 0) {
            for (let i = 0; i < cardsPerPlayer; i++) {
                if (numbers.length === 0) break;
                p.hand.push({
                    cardId: Math.random().toString(36).substr(2, 9),
                    number: numbers.pop(),
                    desc: ""
                });
            }
            if (p.socketId) {
                io.to(p.socketId).emit('yourHand', p.hand);
            }
        }
    }
}

// --- 狼人模式：分配身份 ---
function assignRoles() {
    const activePlayers = Object.values(players).filter(p => !p.isSpectator && p.online);
    const count = activePlayers.length;
    let wolfCount = 0;

    if (count >= 12) wolfCount = 3;
    else if (count >= 7) wolfCount = 2;
    else if (count >= 5) wolfCount = 1;
    else return; // 人数不足，虽然前端限制了，后端兜底

    // 随机选狼
    let wolfIndices = new Set();
    while(wolfIndices.size < wolfCount) {
        wolfIndices.add(Math.floor(Math.random() * count));
    }

    activePlayers.forEach((p, index) => {
        p.role = wolfIndices.has(index) ? 'wolf' : 'villager';
        // 私发身份
        if (p.socketId) {
            io.to(p.socketId).emit('yourRole', p.role);
        }
    });
}

io.on('connection', (socket) => {
    if (autoResetTimer) {
        clearTimeout(autoResetTimer);
        autoResetTimer = null;
    }

    socket.on('login', ({ uid, name }) => {
        if (players[uid]) {
            players[uid].socketId = socket.id;
            players[uid].name = name || players[uid].name;
            players[uid].online = true; 
        } else {
            let isSpectator = false;
            if (gameConfig.status !== 'waiting') { // 只要游戏开始了，新来的就是观众
                isSpectator = true;
            }

            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                hand: [], 
                role: null, // 'villager' | 'wolf'
                isSpectator: isSpectator,
                online: true,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        
        const now = Date.now();
        chatHistory = chatHistory.filter(msg => (now - msg.timestamp) < 5 * 60 * 60 * 1000);

        socket.emit('loginSuccess', {
            me: players[uid],
            gameConfig: gameConfig,
            tableCards: getPublicTableData(),
            chatHistory: chatHistory, 
            activePlayerCount: getActivePlayerCount(),
            votingData: (gameConfig.status === 'voting') ? {
                round: votingData.round,
                tiedCandidates: votingData.tiedCandidates,
                hasVoted: !!votingData.votes[uid] // 告诉前端我是否投过票了
            } : null
        });
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('updateTheme', (theme) => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);

        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    socket.on('requestRandomTheme', () => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        const randomIndex = Math.floor(Math.random() * PRESET_THEMES.length);
        const formattedTheme = `随机主题#${randomIndex + 1}：${PRESET_THEMES[randomIndex]}`;
        
        gameConfig.theme = formattedTheme;
        io.to('gameRoom').emit('updateTheme', formattedTheme);

        if (gameConfig.status === 'playing') {
            dealCardsToPlayers();
        }
    });

    socket.on('startGame', (mode) => {
        resetVotingData();
        tableCards = []; 
        gameConfig.status = 'playing'; 
        gameConfig.mode = mode || 'normal';
        gameConfig.theme = "请设置主题以开始发牌..."; 

        // 如果是狼人模式，检查人数
        if (gameConfig.mode === 'wolf' && getActivePlayerCount() < 5) {
            // 虽然前端挡住了，后端防一手，强制切回普通
            gameConfig.mode = 'normal';
        }

        io.to('gameRoom').emit('updateTheme', gameConfig.theme);
        io.to('gameRoom').emit('gameStarted', { 
            activePlayerCount: getActivePlayerCount(),
            mode: gameConfig.mode
        });

        for (let uid in players) {
            players[uid].isSpectator = false; 
            players[uid].hand = [];
            players[uid].role = null; // 重置身份
            
            const socketId = players[uid].socketId;
            if (socketId && players[uid].online) {
                io.to(socketId).emit('yourHand', []);
                io.to(socketId).emit('yourRole', null); // 清空身份显示
            }
        }

        // 狼人模式分配身份
        if (gameConfig.mode === 'wolf') {
            assignRoles();
        }

        io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('emergencyReset', (password) => {
        let requestPlayer = null;
        for(let uid in players) {
            if (players[uid].socketId === socket.id) {
                requestPlayer = players[uid];
                break;
            }
        }
        if (requestPlayer) {
            if (requestPlayer.isSpectator && password !== 'admin') {
                socket.emit('errorMessage', '管理员密码错误。');
                return;
            }
            resetGameData();
            io.to('gameRoom').emit('forceReset');
        }
    });

    socket.on('updateDesc', ({ uid, cardId, desc }) => {
        const p = players[uid];
        if (p) {
            const card = p.hand.find(c => c.cardId === cardId);
            if (card) card.desc = desc;
        }
    });

    socket.on('playCard', ({ uid, cardId }) => {
        const p = players[uid];
        if (p) {
            const cardIndex = p.hand.findIndex(c => c.cardId === cardId);
            if (cardIndex !== -1) {
                const card = p.hand[cardIndex];
                p.hand.splice(cardIndex, 1);
                tableCards.push({
                    uid: p.uid,
                    cardId: card.cardId,
                    name: p.name,
                    desc: card.desc,
                    number: card.number
                });
                io.to('gameRoom').emit('updateTable', getPublicTableData()); 
                io.to(p.socketId).emit('yourHand', p.hand); 
                io.to('gameRoom').emit('updatePlayerList', Object.values(players));
            }
        }
    });

    socket.on('reorderCards', (newOrderIndices) => {
        if (!Array.isArray(newOrderIndices)) return;
        const newTable = [];
        newOrderIndices.forEach(cardId => {
            const card = tableCards.find(c => c.cardId === cardId);
            if (card) newTable.push(card);
        });
        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        }
    });
    
    socket.on('takeBackCard', ({uid, cardId}) => {
        const p = players[uid];
        if(p && gameConfig.status !== 'revealed' && gameConfig.status !== 'voting') {
            const cardIndex = tableCards.findIndex(c => c.cardId === cardId);
            if (cardIndex !== -1 && tableCards[cardIndex].uid === uid) {
                const card = tableCards[cardIndex];
                tableCards.splice(cardIndex, 1);
                p.hand.push({
                    cardId: card.cardId,
                    number: card.number,
                    desc: card.desc
                });
                io.to('gameRoom').emit('updateTable', getPublicTableData());
                io.to(p.socketId).emit('yourHand', p.hand); 
                io.to('gameRoom').emit('updatePlayerList', Object.values(players));
            }
        }
    });

    socket.on('revealCards', () => {
        const activeCount = getActivePlayerCount();
        if (activeCount === 0) return;

        let allHandsEmpty = true;
        for(let uid in players) {
            const p = players[uid];
            if (!p.isSpectator && p.online && p.hand.length > 0) {
                allHandsEmpty = false;
                break;
            }
        }
        if (tableCards.length === 0 || !allHandsEmpty) return;

        // 检查排序是否成功
        let isSuccess = true;
        let failedIndices = [];
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                failedIndices.push(i); 
            }
        }

        // --- 核心逻辑分歧 ---
        if (gameConfig.mode === 'wolf') {
            gameConfig.status = 'revealed'; // 先设为开牌状态让大家看数字
            
            // 广播开牌结果
            io.to('gameRoom').emit('gameResult', { 
                tableCards: tableCards, 
                isSuccess: isSuccess,
                failedIndices: failedIndices
            });

            if (isSuccess) {
                // 1. 排序成功 -> 平民直接胜利
                io.to('gameRoom').emit('wolfGameEnd', { 
                    winner: 'villager', 
                    reason: 'ito 排序成功！',
                    players: players // 发送所有玩家信息以便展示身份
                });
                finishGame();
            } else {
                // 2. 排序失败 -> 进入投票阶段
                gameConfig.status = 'voting';
                resetVotingData();
                
                setTimeout(() => {
                    io.to('gameRoom').emit('startVoting', { 
                        round: 1, 
                        tiedCandidates: [] 
                    });
                }, 3000); // 延迟3秒让大家看清楚失败的排序
            }

        } else {
            // 普通/双牌模式
            gameConfig.status = 'revealed';
            io.to('gameRoom').emit('gameResult', { 
                tableCards: tableCards, 
                isSuccess: isSuccess,
                failedIndices: failedIndices
            });
            finishGame();
        }
    });

    // --- 狼人投票逻辑 ---
    socket.on('submitVote', ({ uid, targetUid }) => {
        // 校验合法性
        if (gameConfig.status !== 'voting') return;
        if (votingData.votes[uid]) return; // 已经投过了
        
        // 如果是PK轮，投票人不能是候选人，目标必须是候选人
        if (votingData.round > 1) {
            if (votingData.tiedCandidates.includes(uid)) return; // 候选人禁言
            if (!votingData.tiedCandidates.includes(targetUid)) return; // 只能投候选人
        }

        votingData.votes[uid] = targetUid;

        // 检查是否所有有权投票的人都投了
        const activeVoters = Object.values(players).filter(p => {
            if (p.isSpectator || !p.online) return false;
            // PK轮候选人不能投票
            if (votingData.round > 1 && votingData.tiedCandidates.includes(p.uid)) return false;
            return true;
        });

        // 广播进度
        io.to('gameRoom').emit('voteUpdate', {
            votedCount: Object.keys(votingData.votes).length,
            totalCount: activeVoters.length
        });

        if (Object.keys(votingData.votes).length >= activeVoters.length) {
            resolveVotes();
        }
    });

    function resolveVotes() {
        // 统计票数
        let counts = {};
        Object.values(votingData.votes).forEach(target => {
            counts[target] = (counts[target] || 0) + 1;
        });

        // 找出最高票
        let maxVotes = 0;
        for (let target in counts) {
            if (counts[target] > maxVotes) maxVotes = counts[target];
        }

        // 找出所有最高票的人
        let winners = [];
        for (let target in counts) {
            if (counts[target] === maxVotes) winners.push(target);
        }

        // --- 判定逻辑 ---
        
        // 特殊规则：所有人都被指名1票 (Circle) -> 第一轮重投
        // 条件：Round 1，所有人都得1票 (winners数量 == 投票总人数)
        const voterCount = Object.keys(votingData.votes).length;
        if (votingData.round === 1 && winners.length === voterCount && maxVotes === 1) {
            io.to('gameRoom').emit('votingResultInfo', {
                msg: "第一轮投票每人均得1票，视为无效，重新开始第一轮投票！",
                votes: votingData.votes // 公示谁投了谁
            });
            // 重置投票数据但保持Round 1
            votingData.votes = {};
            votingData.tiedCandidates = [];
            setTimeout(() => {
                io.to('gameRoom').emit('startVoting', { round: 1, tiedCandidates: [] });
            }, 4000);
            return;
        }

        // 平票处理
        if (winners.length > 1) {
            if (votingData.round === 1) {
                // 进入PK轮
                votingData.round = 2;
                votingData.votes = {};
                votingData.tiedCandidates = winners;
                
                io.to('gameRoom').emit('votingResultInfo', {
                    msg: "发生平票！即将进入PK轮。",
                    votes: votingData.votes // 这里的votes其实是上一轮的
                });

                setTimeout(() => {
                    io.to('gameRoom').emit('startVoting', { 
                        round: 2, 
                        tiedCandidates: winners 
                    });
                }, 3000);
            } else {
                // PK轮依然平票 -> 狼人胜利
                io.to('gameRoom').emit('wolfGameEnd', {
                    winner: 'wolf',
                    reason: 'PK轮再次平票，狼人获胜！',
                    players: players
                });
                finishGame();
            }
        } else {
            // 有唯一最高票，处决该玩家
            const targetUid = winners[0];
            const targetPlayer = players[targetUid];
            
            if (targetPlayer.role === 'wolf') {
                // 投中狼人 -> 平民胜
                io.to('gameRoom').emit('wolfGameEnd', {
                    winner: 'villager',
                    reason: `成功投票放逐了狼人 (${targetPlayer.name})！`,
                    players: players
                });
            } else {
                // 投错好人 -> 狼人胜
                io.to('gameRoom').emit('wolfGameEnd', {
                    winner: 'wolf',
                    reason: `错误放逐了平民 (${targetPlayer.name})，狼人获胜！`,
                    players: players
                });
            }
            finishGame();
        }
    }

    function finishGame() {
        for (let uid in players) {
            players[uid].isSpectator = false; 
        }
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        io.to('gameRoom').emit('gameEnded'); // 解锁按钮
    }

    socket.on('sendChat', ({ uid, msg }) => {
        const p = players[uid];
        if (p && msg.trim().length > 0) {
            const chatMsg = { 
                name: p.name, 
                msg: msg,
                timestamp: Date.now()
            };
            chatHistory.push(chatMsg);
            if (chatHistory.length > 100) chatHistory.shift();
            io.to('gameRoom').emit('chatMessage', chatMsg);
        }
    });

    socket.on('disconnect', () => {
        for (let uid in players) {
            if (players[uid].socketId === socket.id) {
                players[uid].online = false; 
                break;
            }
        }
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));

        const room = io.sockets.adapter.rooms.get('gameRoom');
        const numClients = room ? room.size : 0;

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
