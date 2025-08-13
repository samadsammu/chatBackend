const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
 cors: {
    origin: [
      "http://localhost:4200",
      /\.ngrok-free\.app$/
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Store users and their information
const users = new Map();
const waitingQueue = [];
const chatRooms = new Map();

class User {
  constructor(socketId, name) {
    this.id = socketId;
    this.name = name;
    this.partner = null;
    this.room = null;
  }
}

function findPartner(currentUser) {
  // Remove current user from waiting queue if they're in it
  const currentUserIndex = waitingQueue.findIndex(user => user.id === currentUser.id);
  if (currentUserIndex !== -1) {
    waitingQueue.splice(currentUserIndex, 1);
  }

  // Find a partner from the waiting queue
  if (waitingQueue.length > 0) {
    const partner = waitingQueue.shift();

    // Create a chat room
    const roomId = `room_${currentUser.id}_${partner.id}`;

    // Set up the partnership
    currentUser.partner = partner;
    currentUser.room = roomId;
    partner.partner = currentUser;
    partner.room = roomId;

    // Store the room
    chatRooms.set(roomId, { user1: currentUser, user2: partner });

    // Join both users to the room
    io.sockets.sockets.get(currentUser.id)?.join(roomId);
    io.sockets.sockets.get(partner.id)?.join(roomId);

    // Notify both users
    io.to(currentUser.id).emit('partnerFound', { id: partner.id, name: partner.name });
    io.to(partner.id).emit('partnerFound', { id: currentUser.id, name: currentUser.name });

    return true;
  }

  return false;
}

function removeUserFromPartnership(user) {
  if (user.partner) {
    const partner = user.partner;
    const roomId = user.room;

    // Notify partner that user left
    if (io.sockets.sockets.get(partner.id)) {
      io.to(partner.id).emit('partnerLeft');
    }

    // Clean up the partnership
    partner.partner = null;
    partner.room = null;
    user.partner = null;
    user.room = null;

    // Remove from chat rooms
    if (roomId) {
      chatRooms.delete(roomId);
    }
  }
}

function removeUserFromQueue(userId) {
  const index = waitingQueue.findIndex(user => user.id === userId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('setUsername', (userName) => {
    console.log(`User ${socket.id} set username: ${userName}`);

    // Create user object
    const user = new User(socket.id, userName.trim());
    users.set(socket.id, user);

    // Try to find a partner
    const foundPartner = findPartner(user);

    if (!foundPartner) {
      // No partner found, add to waiting queue
      waitingQueue.push(user);
      socket.emit('waiting');
      console.log(`User ${userName} added to waiting queue. Queue length: ${waitingQueue.length}`);
    }
  });

  socket.on('sendMessage', (messageContent) => {
    const user = users.get(socket.id);

    if (user && user.partner && user.room) {
      const message = {
        senderName: user.name,
        content: messageContent,
        timestamp: new Date()
      };

      // Send message to partner only
      socket.to(user.partner.id).emit('message', message);
      console.log(`Message sent from ${user.name} to ${user.partner.name}: ${messageContent}`);
    }
  });

  socket.on('findNewPartner', () => {
    const user = users.get(socket.id);

    if (user) {
      console.log(`User ${user.name} looking for new partner`);

      // Remove from current partnership
      removeUserFromPartnership(user);

      // Try to find a new partner
      const foundPartner = findPartner(user);

      if (!foundPartner) {
        // No partner found, add to waiting queue
        waitingQueue.push(user);
        socket.emit('waiting');
        console.log(`User ${user.name} added to waiting queue. Queue length: ${waitingQueue.length}`);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    const user = users.get(socket.id);

    if (user) {
      console.log(`User ${user.name} disconnected`);

      // Remove from partnership if exists
      removeUserFromPartnership(user);

      // Remove from waiting queue
      removeUserFromQueue(socket.id);

      // Remove from users map
      users.delete(socket.id);

      console.log(`Remaining users: ${users.size}, Waiting queue: ${waitingQueue.length}`);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO server ready to accept connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated');
  });
});