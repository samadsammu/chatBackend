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
  /\.ngrok-free\.app$/,
  "https://sorapara.netlify.app",
  "https://sorapara.online"
],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Create video namespace
const videoNamespace = io.of('/video');

app.use(cors());
app.use(express.json());

// Store users and their information
const users = new Map();
const waitingQueue = [];
const chatRooms = new Map();
const groupChatUsers = new Set();
const typingUsers = new Map(); // roomId -> Set of typing users

// Video chat storage
const videoUsers = new Map();
const videoWaitingQueue = [];
const videoRooms = new Map();

class User {
  constructor(socketId, name, mode = 'one-to-one') {
    this.id = socketId;
    this.name = name;
    this.mode = mode;
    this.partner = null;
    this.room = null;
  }
}

class VideoUser {
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

function findVideoPartner(currentUser) {
  // Remove current user from waiting queue if they're in it
  const currentUserIndex = videoWaitingQueue.findIndex(user => user.id === currentUser.id);
  if (currentUserIndex !== -1) {
    videoWaitingQueue.splice(currentUserIndex, 1);
  }

  // Find a partner from the waiting queue
  if (videoWaitingQueue.length > 0) {
    const partner = videoWaitingQueue.shift();
    
    // Create a video room
    const roomId = `video_room_${currentUser.id}_${partner.id}`;
    
    // Set up the partnership
    currentUser.partner = partner;
    currentUser.room = roomId;
    partner.partner = currentUser;
    partner.room = roomId;
    
    // Store the room
    videoRooms.set(roomId, { user1: currentUser, user2: partner });
    
    // Join both users to the room
    videoNamespace.sockets.get(currentUser.id)?.join(roomId);
    videoNamespace.sockets.get(partner.id)?.join(roomId);
    
    // Notify both users
    videoNamespace.to(currentUser.id).emit('videoPartnerFound', { id: partner.id, name: partner.name });
    videoNamespace.to(partner.id).emit('videoPartnerFound', { id: currentUser.id, name: currentUser.name });
    
    return true;
  }
  
  return false;
}

function removeVideoUserFromPartnership(user) {
  if (user.partner) {
    const partner = user.partner;
    const roomId = user.room;
    
    // Notify partner that user left
    if (videoNamespace.sockets.get(partner.id)) {
      videoNamespace.to(partner.id).emit('videoPartnerLeft');
    }
    
    // Clean up the partnership
    partner.partner = null;
    partner.room = null;
    user.partner = null;
    user.room = null;
    
    // Remove from video rooms
    if (roomId) {
      videoRooms.delete(roomId);
    }
  }
}

function removeVideoUserFromQueue(userId) {
  const index = videoWaitingQueue.findIndex(user => user.id === userId);
  if (index !== -1) {
    videoWaitingQueue.splice(index, 1);
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('setUsername', (data) => {
    const { userName, mode } = data;
    console.log(`User ${socket.id} set username: ${userName}, mode: ${mode}`);
    
    // Create user object
    const user = new User(socket.id, userName.trim(), mode);
    users.set(socket.id, user);
    
    if (mode === 'group') {
      // Join group chat
      const roomId = 'publicGroup';
      user.room = roomId;
      socket.join(roomId);
      groupChatUsers.add(user);
      
      // Initialize typing users for this room if not exists
      if (!typingUsers.has(roomId)) {
        typingUsers.set(roomId, new Set());
      }
      
      console.log(`User ${userName} joined group chat. Total group users: ${groupChatUsers.size}`);
    } else {
      // Try to find a partner for one-to-one chat
      const foundPartner = findPartner(user);
      
      if (!foundPartner) {
        // No partner found, add to waiting queue
        waitingQueue.push(user);
        socket.emit('waiting');
        console.log(`User ${userName} added to waiting queue. Queue length: ${waitingQueue.length}`);
      }
    }
  });

  socket.on('sendMessage', (messageContent) => {
    const user = users.get(socket.id);
    
    if (user && user.partner && user.room) {
      // One-to-one chat
      const message = {
        senderName: user.name,
        content: messageContent,
        timestamp: new Date()
      };
      
      // Send message to partner only
      socket.to(user.partner.id).emit('message', message);
      console.log(`Message sent from ${user.name} to ${user.partner.name}: ${messageContent}`);
    } else if (user && user.mode === 'group' && user.room === 'publicGroup') {
      // Group chat
      const message = {
        senderName: user.name,
        content: messageContent,
        timestamp: new Date()
      };
      
      // Broadcast message to all users in group chat except sender
      socket.to('publicGroup').emit('message', message);
      console.log(`Group message sent from ${user.name}: ${messageContent}`);
    }
  });

  socket.on('typing', () => {
    const user = users.get(socket.id);
    
    if (user) {
      if (user.mode === 'group' && user.room === 'publicGroup') {
        // Group chat typing
        const roomTypingUsers = typingUsers.get('publicGroup');
        if (roomTypingUsers) {
          roomTypingUsers.add(user.name);
          socket.to('publicGroup').emit('typing', { userName: user.name });
        }
      } else if (user.partner && user.room) {
        // One-to-one chat typing
        socket.to(user.partner.id).emit('typing', { userName: user.name });
      }
    }
  });

  socket.on('stopTyping', () => {
    const user = users.get(socket.id);
    
    if (user) {
      if (user.mode === 'group' && user.room === 'publicGroup') {
        // Group chat stop typing
        const roomTypingUsers = typingUsers.get('publicGroup');
        if (roomTypingUsers) {
          roomTypingUsers.delete(user.name);
          socket.to('publicGroup').emit('stopTyping');
        }
      } else if (user.partner && user.room) {
        // One-to-one chat stop typing
        socket.to(user.partner.id).emit('stopTyping');
      }
    }
  });

  socket.on('findNewPartner', () => {
    const user = users.get(socket.id);
    
    if (user && user.mode !== 'group') {
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
      
      if (user.mode === 'group') {
        // Remove from group chat
        groupChatUsers.delete(user);
        const roomTypingUsers = typingUsers.get('publicGroup');
        if (roomTypingUsers) {
          roomTypingUsers.delete(user.name);
        }
        console.log(`User ${user.name} left group chat. Remaining group users: ${groupChatUsers.size}`);
      } else {
        // Remove from partnership if exists
        removeUserFromPartnership(user);
        
        // Remove from waiting queue
        removeUserFromQueue(socket.id);
      }
      
      // Remove from users map
      users.delete(socket.id);
      
      console.log(`Remaining users: ${users.size}, Waiting queue: ${waitingQueue.length}`);
    }
  });
});

// Video namespace handlers
videoNamespace.on('connection', (socket) => {
  console.log(`Video user connected: ${socket.id}`);

  socket.on('setUsername', (data) => {
    const { userName } = data;
    console.log(`Video user ${socket.id} set username: ${userName}`);
    
    // Create video user object
    const user = new VideoUser(socket.id, userName.trim());
    videoUsers.set(socket.id, user);
  });

  socket.on('findVideoPartner', () => {
    const user = videoUsers.get(socket.id);
    
    if (user) {
      console.log(`Video user ${user.name} looking for partner`);
      
      // Remove from current partnership if exists
      removeVideoUserFromPartnership(user);
      
      // Try to find a new partner
      const foundPartner = findVideoPartner(user);
      
      if (!foundPartner) {
        // No partner found, add to waiting queue
        videoWaitingQueue.push(user);
        socket.emit('videoWaiting');
        console.log(`Video user ${user.name} added to waiting queue. Queue length: ${videoWaitingQueue.length}`);
      }
    }
  });

  socket.on('videoSignal', (signal) => {
    const user = videoUsers.get(socket.id);
    
    if (user && user.partner && user.room) {
      // Forward signaling data to partner
      socket.to(user.partner.id).emit('videoSignal', signal);
      console.log(`Video signal forwarded from ${user.name} to ${user.partner.name}: ${signal.type}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Video user disconnected: ${socket.id}`);
    
    const user = videoUsers.get(socket.id);
    
    if (user) {
      console.log(`Video user ${user.name} disconnected`);
      
      // Remove from partnership if exists
      removeVideoUserFromPartnership(user);
      
      // Remove from waiting queue
      removeVideoUserFromQueue(socket.id);
      
      // Remove from users map
      videoUsers.delete(socket.id);
      
      console.log(`Remaining video users: ${videoUsers.size}, Video waiting queue: ${videoWaitingQueue.length}`);
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
