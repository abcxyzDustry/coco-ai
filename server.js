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
const AI_API = process.env.AI_API || "https://llm-chat-app-template.djthewolf9.workers.dev/api/chat";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "20", 10);

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
  const res = await fetch(AI_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`AI API ${res.status}: ${txt.slice(0, 200)}`);
  }

  // Parse SSE: dòng "data: {json}" với field "response", kết thúc bằng [DONE]
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
      } catch (e) {
        if (e.message && e.message !== "Unexpected end of JSON input") {
          // ignore parse errors on partial frames
        }
      }
    }
  }

  return full.trim();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Tạo conversation mới
app.post("/api/conversations", async (_req, res) => {
  try {
    const conv = await Conversation.create({});
    res.json({ id: conv._id, title: conv.title, messages: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách
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

// Lấy 1 conversation
app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gửi message → gọi Cloudflare AI → lưu & trả về
app.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "content (string) is required" });
    }

    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    // Thêm tin user
    conv.messages.push({ role: "user", content });

    // Chuẩn bị messages gửi cho AI (cắt theo MAX_HISTORY)
    const history = conv.messages
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }));

    // Gọi AI
    const reply = await callCloudflareAI(history);

    // Lưu reply
    conv.messages.push({ role: "assistant", content: reply });

    // Tự đặt title từ tin nhắn đầu nếu còn mặc định
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

// Endpoint chat không cần lưu (stateless) — tiện cho plugin
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

// Xoá conversation
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
  console.log(`🚀 GroqChat (Cloudflare AI) chạy tại http://localhost:${PORT}`);
});
