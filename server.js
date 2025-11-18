const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
});

// Game configuration
const GAME_CONFIG = {
    ROUND_TIME: 15,
    MAX_SCORE: 3,
    CHOICES: ["stone", "paper", "scissors"]
};

// Enhanced room ID generator
function generateRoomId() {
    const prefixes = ["GAME", "MATCH", "BATTLE", "DUEL"];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${suffix}`;
}

// Data structures
class GameRoom {
    constructor(roomId, player1, player2) {
        this.roomId = roomId;
        this.players = [player1, player2];
        this.choices = { p1: null, p2: null };
        this.scores = { p1: 0, p2: 0 };
        this.round = 1;
        this.timer = null;
        this.isGameActive = true;
        this.gameOver = false;
    }

    resetChoices() {
        this.choices = { p1: null, p2: null };
    }

    getPlayerIndex(socketId) {
        return this.players.indexOf(socketId);
    }

    isReady() {
        return this.choices.p1 !== null && this.choices.p2 !== null;
    }

    cleanup() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.isGameActive = false;
    }
}

let matchmakingQueue = [];
let rooms = new Map();

// Matchmaking system
function tryMatchPlayers() {
    while (matchmakingQueue.length >= 2) {
        const player1 = matchmakingQueue.shift();
        const player2 = matchmakingQueue.shift();

        const roomId = generateRoomId();
        const room = new GameRoom(roomId, player1, player2);

        rooms.set(roomId, room);

        // Join room
        io.sockets.sockets.get(player1)?.join(roomId);
        io.sockets.sockets.get(player2)?.join(roomId);

        // Notify players
        io.to(player1).emit("matchFound", {
            roomId,
            opponent: player2,
            playerNumber: 1
        });

        io.to(player2).emit("matchFound", {
            roomId,
            opponent: player1,
            playerNumber: 2
        });

        console.log(`🎮 Match created: ${roomId} → ${player1} vs ${player2}`);

        // Start first round after a brief delay
        setTimeout(() => {
            startRound(roomId);
        }, 1000);
    }
}

// Game logic
function calculateWinner(choice1, choice2) {
    if (choice1 === choice2) return "draw";

    const winConditions = {
        stone: "scissors",
        scissors: "paper",
        paper: "stone"
    };

    return winConditions[choice1] === choice2 ? "p1" : "p2";
}

function startRound(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.isGameActive || room.gameOver) return;

    room.resetChoices();

    // Notify players new round is starting
    io.to(roomId).emit("roundStart", {
        round: room.round,
        timeLimit: GAME_CONFIG.ROUND_TIME,
        scores: room.scores
    });

    console.log(`🔄 Round ${room.round} starting in room ${roomId}`);

    // Set timer for round
    room.timer = setTimeout(() => {
        handleRoundTimeout(roomId);
    }, GAME_CONFIG.ROUND_TIME * 1000);
}

function handleRoundTimeout(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;

    const results = {
        p1: room.choices.p1 || "timeout",
        p2: room.choices.p2 || "timeout",
        winner: "timeout",
        score: { ...room.scores },
        round: room.round
    };

    // Handle timeout logic - if one player didn't choose, the other wins
    if (room.choices.p1 && !room.choices.p2) {
        results.winner = "p1";
        room.scores.p1++;
    } else if (!room.choices.p1 && room.choices.p2) {
        results.winner = "p2";
        room.scores.p2++;
    }
    // If both didn't choose, it remains "timeout" with no score change

    results.score = { ...room.scores };

    io.to(roomId).emit("roundResult", results);
    console.log(`⏰ Round timeout in ${roomId}: ${results.winner}`);

    room.round++;

    // Check for game end
    checkGameEnd(roomId);
}

function checkGameEnd(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;

    if (room.scores.p1 >= GAME_CONFIG.MAX_SCORE || room.scores.p2 >= GAME_CONFIG.MAX_SCORE) {
        endGame(roomId);
    } else {
        // Start next round after delay
        setTimeout(() => startRound(roomId), 3000);
    }
}

function endGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.gameOver = true;
    const winner = room.scores.p1 > room.scores.p2 ? "p1" :
                  room.scores.p2 > room.scores.p1 ? "p2" : "draw";

    io.to(roomId).emit("gameOver", {
        winner,
        finalScore: room.scores,
        totalRounds: room.round - 1
    });

    console.log(`🏁 Game over in ${roomId}: ${winner}`);

    // Cleanup after delay
    setTimeout(() => {
        room.cleanup();
        rooms.delete(roomId);
        console.log(`🗑️ Room cleaned up: ${roomId}`);
    }, 5000);
}

// Socket connection handler
io.on("connection", (socket) => {
    console.log("🎯 Player connected:", socket.id);

    // Player enters matchmaking
    socket.on("findMatch", () => {
        if (!matchmakingQueue.includes(socket.id)) {
            matchmakingQueue.push(socket.id);
            socket.emit("searching", {
                message: "Searching for opponent...",
                queuePosition: matchmakingQueue.length
            });
            console.log(`🔍 ${socket.id} joined matchmaking queue`);
            tryMatchPlayers();
        }
    });

    // Player makes choice
    socket.on("playerChoice", ({ roomId, choice }) => {
        const room = rooms.get(roomId);
        if (!room || !room.isGameActive || room.gameOver) {
            socket.emit("error", "Game not found or ended");
            return;
        }

        if (!GAME_CONFIG.CHOICES.includes(choice)) {
            socket.emit("error", "Invalid choice");
            return;
        }

        const playerIndex = room.getPlayerIndex(socket.id);
        if (playerIndex === -1) {
            socket.emit("error", "Player not in room");
            return;
        }

        const playerKey = `p${playerIndex + 1}`;
        room.choices[playerKey] = choice;

        console.log(`🎯 ${socket.id} chose ${choice} in ${roomId}`);

        // Notify choice made
        socket.emit("choiceRegistered", { choice });
        socket.to(roomId).emit("opponentChoiceMade");

        // Both players have chosen
        if (room.isReady()) {
            clearTimeout(room.timer);

            const result = calculateWinner(room.choices.p1, room.choices.p2);

            // Update scores
            if (result === "p1") room.scores.p1++;
            if (result === "p2") room.scores.p2++;

            const roundResult = {
                p1: room.choices.p1,
                p2: room.choices.p2,
                winner: result,
                score: { ...room.scores },
                round: room.round
            };

            io.to(roomId).emit("roundResult", roundResult);
            console.log(`🎯 Round ${room.round} result in ${roomId}: ${result}`);

            room.round++;

            // Check for game end
            setTimeout(() => checkGameEnd(roomId), 3000);
        }
    });

    // Player cancels matchmaking
    socket.on("cancelMatchmaking", () => {
        const wasInQueue = matchmakingQueue.includes(socket.id);
        matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);
        if (wasInQueue) {
            socket.emit("matchmakingCancelled");
            console.log(`❌ ${socket.id} cancelled matchmaking`);
        }
    });

    // Player disconnects
    socket.on("disconnect", (reason) => {
        console.log("👋 Player disconnected:", socket.id, "Reason:", reason);

        // Remove from matchmaking
        matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);

        // Handle room cleanup
        for (let [roomId, room] of rooms) {
            if (room.players.includes(socket.id)) {
                socket.to(roomId).emit("opponentLeft", "Your opponent disconnected.");
                console.log(`⚠️ ${socket.id} disconnected from ${roomId}`);

                // End the game immediately
                room.cleanup();
                rooms.delete(roomId);
                break;
            }
        }
    });

    // Error handling
    socket.on("error", (error) => {
        console.error("Socket error:", socket.id, error);
    });
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        playersOnline: io.engine.clientsCount,
        activeRooms: rooms.size,
        inQueue: matchmakingQueue.length,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 RPS Arena Server running on port ${PORT}`);
    console.log(`🎯 Game Config: ${GAME_CONFIG.MAX_SCORE} points to win, ${GAME_CONFIG.ROUND_TIME}s rounds`);
});