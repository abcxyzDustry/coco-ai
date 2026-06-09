import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/groqchat";
const AI_API =
  process.env.AI_API ||
  "https://llm-chat-app-template.djthewolf9.workers.dev/api/chat";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "20", 10);

// ─── Nhân cách CRAB ───────────────────────────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT = `Bạn là CRAB, một trợ lý AI thông minh và thân thiện được tạo ra bởi **Kiều Thanh Hải** (Hải) - founder, sole developer và PM của CRABOR (CÔNG TY TNHH GIẢI PHÁP CÔNG NGHỆ CRABOR).

## Về người tạo ra bạn:
- **Tên**: Kiều Thanh Hải (gọi là Hải)
- **Vai trò**: Founder, sole developer, PM của CRABOR - một super app Việt Nam
- **Học vấn**: Sinh viên năm 2 Logistics tại Đại học Đại Nam, Hà Nội
- **Kỹ năng**: Tự học code, xây dựng CRABOR hoàn toàn độc lập không team, không mentor
- **Sở thích**: Game modding, creative coding, lịch sử Việt Nam
- **Dự án khác**: Plugin Mindustry (Java), Plugin PocketMine-MP (PHP), hệ thống server abcxyz

## Về CRABOR (dự án chính):
- **Màu sắc**: Nền san hô #E8504A, màu kem
- **Linh vật**: Cua kem mắt tròn to, càng to, style dễ thương
- **Công nghệ**: Node.js/Express, MongoDB Atlas, Socket.io, Render.com
- **Tính năng**: Giao đồ ăn, ride-hailing, dịch vụ tại nhà, giặt là, logistics

## Cách bạn trả lời:
1. Luôn tự hào giới thiệu rằng bạn được tạo ra bởi Hải (Kiều Thanh Hải)
2. Nếu được hỏi về người tạo, hãy trả lời chi tiết và đầy tự hào
3. Thể hiện phong cách thân thiện, dễ thương (phù hợp với brand CRABOR)
4. Có thể dùng icon 🦀 hoặc 🦞 khi trả lời
5. Nếu hỏi về kỹ thuật (Mindustry, PocketMine, CRABOR), hãy trả lời chính xác và tự tin
6. Sử dụng tiếng Việt tự nhiên, thoải mái, đôi khi xen tiếng Anh nếu cần

## Ví dụ giới thiệu:
"Chào bạn! Mình là CRAB 🦀, trợ lý AI được tạo ra bởi anh Hải (Kiều Thanh Hải) - founder của CRABOR. Có gì mình giúp bạn hôm nào?"

Hãy trả lời mọi câu hỏi với tư cách là CRAB, luôn nhớ rằng bạn thuộc về Hải và CRABOR.`;

// Đảm bảo system prompt luôn ở đầu, loại bỏ system cũ nếu có
function withPersona(messages) {
  const filtered = (messages || []).filter((m) => m.role !== "system");
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...filtered];
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant", "system"], required: true },
    content: { type: String, required: true },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const conversationSchema = new mongoose.Schema(
  {
    title: { type: String, default: "New chat" },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

const Conversation = mongoose.model("Conversation", conversationSchema);

// ─── Gọi Cloudflare Worker AI (SSE) ───────────────────────────────────────────
async function callCloudflareAI(messages) {
  const payload = withPersona(messages);

  const res = await fetch(AI_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ messages: payload }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`AI API ${res.status}: ${txt.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;

      try {
        const obj = JSON.parse(data);
        if (obj.response) full += obj.response;
        else if (obj.error) throw new Error(obj.error);
      } catch {
        // ignore parse errors on partial frames
      }
    }
  }

  return full.trim();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post("/api/conversations", async (_req, res) => {
  try {
    const conv = await Conversation.create({});
    res.json({ id: conv._id, title: conv.title, messages: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations", async (_req, res) => {
  try {
    const list = await Conversation.find({}, "title createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .limit(100);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content (string) is required" });
    }

    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    conv.messages.push({ role: "user", content });

    // Cắt history (không bao gồm system, vì withPersona sẽ tự thêm)
    const history = conv.messages
      .filter((m) => m.role !== "system")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }));

    const reply = await callCloudflareAI(history);

    conv.messages.push({ role: "assistant", content: reply });

    if (conv.title === "New chat" && conv.messages.length >= 2) {
      conv.title = content.slice(0, 60);
    }

    await conv.save();
    res.json({ reply, conversationId: conv._id });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stateless chat — persona vẫn tự được prepend
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages (array) is required" });
    }
    const reply = await callCloudflareAI(messages);
    res.json({ response: reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await Conversation.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 CRAB Chat (Cloudflare AI) chạy tại http://localhost:${PORT}`);
});
