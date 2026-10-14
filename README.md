# 📹 MeetSpace — Real-Time Video Collaboration & Meeting Platform

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-5.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.x-010101?logo=socket.io&logoColor=white)](https://socket.io/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P_Mesh-FF6C37?logo=webrtc&logoColor=white)](https://webrtc.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

**MeetSpace** is a full-stack, real-time collaboration application designed for secure video conferencing, instant messaging, interactive whiteboarding, screen sharing, and file distribution. Built from the ground up without heavy third-party video SDKs, it utilizes vanilla WebRTC and Socket.io to establish high-performance peer-to-peer media streams.

---

## 🚀 Key Features

### 🔐 1. Authentication & Session Management
- **User Registration & Login:** Protected by salted password hashing using `bcryptjs`.
- **JWT Authorization:** Stateless session tokens (`jsonwebtoken`) stored securely in `localStorage` with a 7-day expiration.
- **Protected Real-Time Sockets:** Socket.io handshake middleware validates JWTs before granting room access.

### 📹 2. Multi-User WebRTC Video Calling
- **P2P Mesh Network:** Up to 6 participants per room with direct, low-latency, encrypted audio/video channels.
- **STUN Server Integration:** Automatic NAT traversal using Google's public STUN servers for network discovery.
- **Dynamic In-Call Hardware Controls:**
  - 🎤 **Mute / Unmute:** Disables microphone hardware tracks and broadcasts status updates to all participants.
  - 🎥 **Camera On / Off:** Turns off webcam capture with fallback placeholders (`📷`).
  - 🔇 **Live Status Badges:** Visual indicators synced in real time on each participant's tile.

### 🖥️ 3. Seamless Screen Sharing
- **Track Replacement API:** Swaps active camera tracks with screen capture streams on the fly using `RTCRtpSender.replaceTrack()` without reconnecting or interrupting calls.
- **Automatic Fallback:** Restores local camera stream seamlessly when screen sharing is stopped.

### 💬 4. In-Call Chat & Real-Time Alerts
- **Room-Scoped Messaging:** Instant message delivery to all participants inside the active meeting room.
- **Notification Badges:** Unread message counter badge on the chat toggle button when the panel is closed.
- **System Events:** Automatic broadcast alerts when users join or leave the room.

### 📎 5. File Sharing (Up to 25 MB)
- **Multi-Part Uploads:** Integrated with `multer` for secure, temporary disk storage.
- **Interactive File Cards:** In-chat download cards featuring file name, formatted size (KB/MB), and direct download links.

### 🎨 6. Real-Time Collaborative Whiteboard
- **Synchronized Drawing:** Simultaneous multi-user canvas drawing with cross-hair cursor feedback.
- **Normalized Coordinates:** Transmits relative position fractions ($0.0$ to $1.0$) rather than absolute pixels, ensuring precise stroke alignment across devices with different screen resolutions.
- **Full Toolkit:** Color swatches, brush size adjustments, eraser tool, and full canvas clear.
- **Catch-up History:** Late-joining participants automatically receive the complete whiteboard history upon entering the room.
- **PNG Export:** One-click canvas download with high-contrast background rendering.

---

## 🏗️ Technical Architecture
                              +-------------------+
                              |   Node.js Server  |
                              | (Express + JWT)   |
                              +---------+---------+
                                        |
                   1. Signaling / Auth  |  2. Chat, Files, Whiteboard
                                        v
 +---------------------------------- Socket.io -----------------------------------+
 |                                                                                |
 v                                                                                v
 
### Signaling vs. Media Pipeline
1. **Signaling Server (Socket.io):** Handles session orchestration, room capacity management, SDP Offers, SDP Answers, and ICE candidate exchanges.
2. **Media Pipeline (WebRTC):** Once signaling completes, audio and video streams travel directly between client browsers via peer-to-peer data channels. The central Node.js server does not process or relay raw video streams, minimizing server bandwidth and CPU usage.

---

## 📂 Project Structure

```text
meetspace/
├── data/                    # Local storage (JSON user records, JWT secret)
│   ├── secret.txt
│   └── users.json
├── uploads/                 # Temporary storage for shared files (up to 25 MB)
├── public/                  # Frontend client assets
│   ├── app.js               # Application logic, WebRTC mesh, canvas, and socket events
│   ├── index.html           # Single-page UI (Auth, Lobby, Room, Panels)
│   └── style.css            # Responsive dark theme & layout styles
├── .gitignore               # Excludes node_modules, data, and uploads from git
├── package.json             # Dependencies and npm scripts
├── package-lock.json        # Pinned dependency tree
├── README.md                # Project documentation
└── server.js                # Express app, Multer routes, and Socket.io signaling
