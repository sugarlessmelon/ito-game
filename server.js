/**
 * Ito Online Server - Ver.3.0
 * 包含：狼人模式完整逻辑、拖拽互斥锁、投票倒计时、防挂机、掉线保护
 */

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
// 拖拽锁: { cardId: uid }，记录哪张牌正在被谁拖动
let dragLocks = {}; 

let gameConfig = {
    theme: "等待设置题目...",
    status: "waiting", // 'waiting', 'playing', 'revealed', 'voting', 'game_over'
    mode: "normal" 
};

// 投票数据
let votingData = {
    round: 1,
    votes: {},          // { voterUid: targetUid }
    tiedCandidates: [],
    timer: null,        // 倒计时引用
    endTime: 0          // 倒计时结束时间戳
};

let autoResetTimer = null;

// 获取公开桌面数据
function getPublicTableData() {
    // 修改点：在投票阶段(voting)和游戏彻底结束(game_over)时，必须显示数字
    const showNumbers = ['revealed', 'voting', 'game_over'].includes(gameConfig.status);

    if (showNumbers) {
        return tableCards.map(c => ({
            ...c,
            lockedBy: dragLocks[c.cardId] || null // 即使显示数字也要传锁状态
        }));
    } else {
        return tableCards.map(c => ({
            uid: c.uid,
            cardId: c.cardId,
            name: c.name,
            desc: c.desc,
            lockedBy: dragLocks[c.cardId] || null, // 传递锁状态
            number: null 
        }));
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
    dragLocks = {}; // 清空锁
    gameConfig = {
        theme: "等待设置题目...",
        status: "waiting",
        mode: "normal"
    };
    resetVotingData();
}

function resetVotingData() {
    if (votingData.timer) clearTimeout(votingData.timer);
    votingData = {
        round: 1,
        votes: {},
        tiedCandidates: [],
        timer: null,
        endTime: 0
    };
}

function dealCardsToPlayers() {
    let numbers = Array.from({length: 100}, (_, i) => i + 1);
    numbers.sort(() => Math.random() - 0.5);
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
            if (p.socketId) io.to(p.socketId).emit('yourHand', p.hand);
        }
    }
}

function assignRoles() {
    const activePlayers = Object.values(players).filter(p => !p.isSpectator && p.online);
    const count = activePlayers.length;
    let wolfCount = 0;

    if (count >= 12) wolfCount = 3;
    else if (count >= 7) wolfCount = 2;
    else if (count >= 5) wolfCount = 1;
    else return; 

    let wolfIndices = new Set();
    while(wolfIndices.size < wolfCount) {
        wolfIndices.add(Math.floor(Math.random() * count));
    }

    activePlayers.forEach((p, index) => {
        p.role = wolfIndices.has(index) ? 'wolf' : 'villager';
        if (p.socketId) io.to(p.socketId).emit('yourRole', p.role);
    });
}

// --- 投票超时处理 ---
function handleVotingTimeout() {
    console.log("投票时间到，执行强制随机投票...");
    const activeVoters = Object.values(players).filter(p => {
        if (p.isSpectator || !p.online) return false;
        if (votingData.round > 1 && votingData.tiedCandidates.includes(p.uid)) return false;
        return true;
    });

    activeVoters.forEach(voter => {
        // 如果这人还没投
        if (!votingData.votes[voter.uid]) {
            // 确定合法的目标池
            let validTargets = [];
            if (votingData.round === 1) {
                validTargets = Object.values(players)
                    .filter(t => !t.isSpectator && t.online && t.uid !== voter.uid)
                    .map(t => t.uid);
            } else {
                validTargets = votingData.tiedCandidates.filter(uid => uid !== voter.uid);
            }

            if (validTargets.length > 0) {
                const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
                votingData.votes[voter.uid] = randomTarget;
                // 通知前端他“被”投票了
                if (voter.socketId) io.to(voter.socketId).emit('forceVote', randomTarget);
            }
        }
    });

    // 强制结算
    resolveVotes();
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
            if (gameConfig.status !== 'waiting') { 
                isSpectator = true;
            }

            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                hand: [], 
                role: null, 
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
                hasVoted: !!votingData.votes[uid],
                endTime: votingData.endTime // 发送倒计时截止时间
            } : null
        });
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('updateTheme', (theme) => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);

        if (gameConfig.status === 'playing') dealCardsToPlayers();
    });

    socket.on('requestRandomTheme', () => {
        if (gameConfig.status !== 'playing' && gameConfig.status !== 'waiting') return;
        if (tableCards.length > 0) return;

        const randomIndex = Math.floor(Math.random() * PRESET_THEMES.length);
        const formattedTheme = `随机主题#${randomIndex + 1}：${PRESET_THEMES[randomIndex]}`;
        
        gameConfig.theme = formattedTheme;
        io.to('gameRoom').emit('updateTheme', formattedTheme);

        if (gameConfig.status === 'playing') dealCardsToPlayers();
    });

    socket.on('startGame', (mode) => {
        resetVotingData();
        dragLocks = {}; // 清空拖拽锁
        tableCards = []; 
        gameConfig.status = 'playing'; 
        gameConfig.mode = mode || 'normal';
        gameConfig.theme = "请设置主题以开始发牌..."; 

        if (gameConfig.mode === 'wolf' && getActivePlayerCount() < 5) {
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
            players[uid].role = null; 
            
            const socketId = players[uid].socketId;
            if (socketId && players[uid].online) {
                io.to(socketId).emit('yourHand', []);
                io.to(socketId).emit('yourRole', null); 
            }
        }

        if (gameConfig.mode === 'wolf') assignRoles();

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

    // --- 拖拽锁逻辑 ---
    socket.on('cardDragStart', ({ uid, cardId }) => {
        // 只有未被锁的才能锁
        if (!dragLocks[cardId]) {
            dragLocks[cardId] = uid;
            // 广播更新（前端看到锁会变灰）
            io.to('gameRoom').emit('updateTable', getPublicTableData());
        }
    });

    socket.on('cardDragEnd', ({ uid, cardId }) => {
        // 只有锁的主人才能解锁
        if (dragLocks[cardId] === uid) {
            delete dragLocks[cardId];
            // 这里通常不需要广播，因为紧接着会触发 reorderCards，那里会广播
            // 但为了保险（比如拖动没改变位置），可以广播一下，或者等reorder覆盖
            io.to('gameRoom').emit('updateTable', getPublicTableData());
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
        if(p && gameConfig.status !== 'revealed' && gameConfig.status !== 'voting' && gameConfig.status !== 'game_over') {
            const cardIndex = tableCards.findIndex(c => c.cardId === cardId);
            if (cardIndex !== -1 && tableCards[cardIndex].uid === uid) {
                // 如果被别人锁住了，不能收回
                if (dragLocks[cardId] && dragLocks[cardId] !== uid) return;

                const card = tableCards[cardIndex];
                tableCards.splice(cardIndex, 1);
                delete dragLocks[cardId]; // 清除锁

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

        let isSuccess = true;
        let failedIndices = [];
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                failedIndices.push(i); 
            }
        }

        // 先全部公开数字
        gameConfig.status = 'revealed';
        io.to('gameRoom').emit('gameResult', { 
            tableCards: tableCards, // 发送含数字数据
            isSuccess: isSuccess,
            failedIndices: failedIndices
        });

        if (gameConfig.mode === 'wolf') {
            if (isSuccess) {
                finishWolfGame('villager', 'ito 排序成功！平民直接胜利！');
            } else {
                // 失败，进入投票
                gameConfig.status = 'voting';
                resetVotingData();
                
                // 3秒后开始投票
                setTimeout(() => {
                    // 设置120秒倒计时
                    votingData.endTime = Date.now() + 120000; 
                    votingData.timer = setTimeout(handleVotingTimeout, 120000);

                    io.to('gameRoom').emit('startVoting', { 
                        round: 1, 
                        tiedCandidates: [],
                        endTime: votingData.endTime
                    });
                }, 3000); 
            }
        } else {
            // 普通模式结束
            finishGame();
        }
    });

    socket.on('submitVote', ({ uid, targetUid }) => {
        if (gameConfig.status !== 'voting') return;
        if (votingData.votes[uid]) return; 
        
        if (votingData.round > 1) {
            if (votingData.tiedCandidates.includes(uid)) return; 
            if (!votingData.tiedCandidates.includes(targetUid)) return; 
        }

        votingData.votes[uid] = targetUid;

        const activeVoters = Object.values(players).filter(p => {
            if (p.isSpectator || !p.online) return false;
            if (votingData.round > 1 && votingData.tiedCandidates.includes(p.uid)) return false;
            return true;
        });

        io.to('gameRoom').emit('voteUpdate', {
            votedCount: Object.keys(votingData.votes).length,
            totalCount: activeVoters.length
        });

        if (Object.keys(votingData.votes).length >= activeVoters.length) {
            // 全部投完，清除定时器，立即结算
            if (votingData.timer) clearTimeout(votingData.timer);
            resolveVotes();
        }
    });

    function resolveVotes() {
        let counts = {};
        Object.values(votingData.votes).forEach(target => {
            counts[target] = (counts[target] || 0) + 1;
        });

        let maxVotes = 0;
        for (let target in counts) {
            if (counts[target] > maxVotes) maxVotes = counts[target];
        }

        let winners = [];
        for (let target in counts) {
            if (counts[target] === maxVotes) winners.push(target);
        }

        // --- 构建投票详情 ---
        let voteDetails = {}; // { voterName: targetName }
        for(let voterId in votingData.votes) {
            const targetId = votingData.votes[voterId];
            if(players[voterId] && players[targetId]) {
                voteDetails[players[voterId].name] = players[targetId].name;
            }
        }

        // 特殊规则：第一轮全员1票
        const voterCount = Object.keys(votingData.votes).length;
        if (votingData.round === 1 && winners.length === voterCount && maxVotes === 1) {
            io.to('gameRoom').emit('votingResultInfo', {
                msg: "第一轮投票每人均得1票，无效！重新开始投票。",
                voteDetails: voteDetails // 显示谁投了谁
            });
            votingData.votes = {};
            votingData.tiedCandidates = [];
            // 重启倒计时
            if (votingData.timer) clearTimeout(votingData.timer);
            setTimeout(() => {
                votingData.endTime = Date.now() + 120000;
                votingData.timer = setTimeout(handleVotingTimeout, 120000);
                io.to('gameRoom').emit('startVoting', { round: 1, tiedCandidates: [], endTime: votingData.endTime });
            }, 4000);
            return;
        }

        if (winners.length > 1) {
            if (votingData.round === 1) {
                votingData.round = 2;
                // 保留旧的 votes 用于展示，但清空用于下一轮
                const lastVotes = voteDetails;
                votingData.votes = {};
                votingData.tiedCandidates = winners;
                
                io.to('gameRoom').emit('votingResultInfo', {
                    msg: "平票！进入PK轮。",
                    voteDetails: lastVotes
                });

                if (votingData.timer) clearTimeout(votingData.timer);
                setTimeout(() => {
                    votingData.endTime = Date.now() + 120000;
                    votingData.timer = setTimeout(handleVotingTimeout, 120000);
                    io.to('gameRoom').emit('startVoting', { 
                        round: 2, 
                        tiedCandidates: winners,
                        endTime: votingData.endTime
                    });
                }, 3000);
            } else {
                finishWolfGame('wolf', 'PK轮再次平票，狼人获胜！', voteDetails);
            }
        } else {
            const targetUid = winners[0];
            const targetPlayer = players[targetUid];
            
            if (targetPlayer.role === 'wolf') {
                finishWolfGame('villager', `成功放逐了狼人 (${targetPlayer.name})！`, voteDetails);
            } else {
                finishWolfGame('wolf', `错误放逐了平民 (${targetPlayer.name})，狼人获胜！`, voteDetails);
            }
        }
    }

    function finishWolfGame(winner, reason, voteDetails = null) {
        gameConfig.status = 'game_over';
        io.to('gameRoom').emit('wolfGameEnd', {
            winner: winner,
            reason: reason,
            players: players,
            voteDetails: voteDetails
        });
        finishGame();
    }

    function finishGame() {
        for (let uid in players) {
            players[uid].isSpectator = false; 
        }
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        io.to('gameRoom').emit('gameEnded'); 
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
                // 清除他持有的拖拽锁
                for (let cardId in dragLocks) {
                    if (dragLocks[cardId] === uid) delete dragLocks[cardId];
                }
                break;
            }
        }
        
        io.to('gameRoom').emit('updateTable', getPublicTableData()); // 更新锁状态
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
