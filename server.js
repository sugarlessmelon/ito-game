const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {}; 
let tableCards = []; 
let gameConfig = {
    theme: "等待设置题目...",
    isRevealed: false
};

function getPublicTableData() {
    if (gameConfig.isRevealed) {
        return tableCards; 
    } else {
        return tableCards.map(c => ({
            uid: c.uid,
            name: c.name,
            desc: c.desc,
            number: null 
        }));
    }
}

io.on('connection', (socket) => {
    socket.on('login', ({ uid, name }) => {
        if (players[uid]) {
            players[uid].socketId = socket.id; 
            if(name) players[uid].name = name; 
        } else {
            players[uid] = {
                uid: uid,
                name: name || "无名氏",
                card: null,
                desc: "",
                isPlayed: false,
                socketId: socket.id
            };
        }
        
        socket.join('gameRoom');
        socket.emit('loginSuccess', players[uid]);
        
        socket.emit('gameState', {
            theme: gameConfig.theme,
            isRevealed: gameConfig.isRevealed,
            tableCards: getPublicTableData() 
        });
        
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('updateTheme', (theme) => {
        gameConfig.theme = theme;
        io.to('gameRoom').emit('updateTheme', theme);
    });

    socket.on('startGame', () => {
        tableCards = []; 
        gameConfig.isRevealed = false; 
        
        let numbers = Array.from({length: 100}, (_, i) => i + 1);
        numbers.sort(() => Math.random() - 0.5);

        for (let uid in players) {
            players[uid].card = numbers.pop();
            players[uid].desc = "";     
            players[uid].isPlayed = false;
            
            const socketId = players[uid].socketId;
            if (socketId) {
                io.to(socketId).emit('yourCard', { number: players[uid].card, desc: "" });
            }
        }

        io.to('gameRoom').emit('gameStarted');
        io.to('gameRoom').emit('updateTable', getPublicTableData()); 
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    socket.on('updateDesc', ({ uid, desc }) => {
        if (players[uid]) {
            players[uid].desc = desc;
        }
    });

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

    socket.on('reorderCards', (newOrderIndices) => {
        if (!Array.isArray(newOrderIndices)) return;
        
        const newTable = [];
        newOrderIndices.forEach(uid => {
            const card = tableCards.find(c => c.uid === uid);
            if (card) newTable.push(card);
        });

        if (newTable.length === tableCards.length) {
            tableCards = newTable;
            socket.to('gameRoom').emit('updateTable', getPublicTableData()); 
        }
    });
    
    socket.on('takeBackCard', ({uid}) => {
        const p = players[uid];
        if(p && p.isPlayed && !gameConfig.isRevealed) {
            p.isPlayed = false;
            tableCards = tableCards.filter(c => c.uid !== uid);
            io.to('gameRoom').emit('updateTable', getPublicTableData());
            io.to('gameRoom').emit('playerTakenBack', uid);
            io.to('gameRoom').emit('updatePlayerList', Object.values(players));
        }
    });

    socket.on('revealCards', () => {
        gameConfig.isRevealed = true;
        
        let isSuccess = true;
        let failedIndices = [];
        
        for (let i = 0; i < tableCards.length - 1; i++) {
            if (tableCards[i].number > tableCards[i+1].number) {
                isSuccess = false;
                failedIndices.push(i); 
            }
        }
        
        io.to('gameRoom').emit('gameResult', { 
            tableCards: tableCards, 
            isSuccess: isSuccess,
            failedIndices: failedIndices
        });
    });

    socket.on('resetGame', () => {
        gameConfig.theme = "等待设置题目...";
        gameConfig.isRevealed = false;
        tableCards = [];
        for(let uid in players) {
            players[uid].card = null;
            players[uid].desc = "";
            players[uid].isPlayed = false;
        }
        io.to('gameRoom').emit('resetGame');
        io.to('gameRoom').emit('updatePlayerList', Object.values(players));
    });

    // --- 新增：聊天处理 ---
    socket.on('sendChat', ({ uid, msg }) => {
        const p = players[uid];
        if (p && msg.trim().length > 0) {
            // 广播给所有人
            io.to('gameRoom').emit('chatMessage', { name: p.name, msg: msg });
        }
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
