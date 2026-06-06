import express from "express";
import cors from "cors";
import Groq from "groq-sdk";
import mongoose from "mongoose";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/groqchat";

// ─── Groq client ──────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── MongoDB schemas ──────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
  role:           { type: String, enum: ["user", "assistant", "system"], required: true },
  content:        { type: String, required: true },
  model:          { type: String, default: null },
  tokens:         { type: Number, default: null },
}, { timestamps: { createdAt: "createdAt", updatedAt: false } });

const conversationSchema = new mongoose.Schema({
  title:        { type: String, default: "New Conversation" },
  model:        { type: String, default: null },
  systemPrompt: { type: String, default: null },
}, { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } });

const Message      = mongoose.model("Message",      messageSchema);
const Conversation = mongoose.model("Conversation", conversationSchema);

// ─── Kết nối MongoDB ──────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected:", MONGO_URI))
  .catch(err => { console.error("MongoDB connection error:", err.message); process.exit(1); });

// ─── Models Groq có sẵn ───────────────────────────────────────────────────────
const AVAILABLE_MODELS = [
  { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", contextWindow: 128000 },
  { id: "llama-3.1-8b-instant",    name: "Llama 3.1 8B Instant",    contextWindow: 128000 },
  { id: "mixtral-8x7b-32768",      name: "Mixtral 8x7B",            contextWindow: 32768  },
  { id: "gemma2-9b-it",            name: "Gemma 2 9B",              contextWindow: 8192   },
];

const DEFAULT_MODEL = "llama-3.3-70b-versatile";

app.use(cors());
app.use(express.json());

// ─── Phục vụ file HTML tĩnh ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '.'))); // Phục vụ file trong thư mục hiện tại

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Models ───────────────────────────────────────────────────────────────────
app.get("/api/models", (_req, res) => {
  res.json(AVAILABLE_MODELS);
});

// ─── Conversations ────────────────────────────────────────────────────────────

// Lấy danh sách hội thoại (kèm số lượng tin nhắn)
app.get("/api/conversations", async (_req, res) => {
  try {
    const conversations = await Conversation.find().sort({ updatedAt: -1 }).lean();

    const withCount = await Promise.all(
      conversations.map(async (conv) => ({
        ...conv,
        id: conv._id,
        messageCount: await Message.countDocuments({ conversationId: conv._id }),
      }))
    );

    res.json(withCount);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tạo hội thoại mới
app.post("/api/conversations", async (req, res) => {
  try {
    const { title = "New Conversation", model = null, systemPrompt = null } = req.body || {};
    const conv = await Conversation.create({ title, model, systemPrompt });
    res.status(201).json({ ...conv.toObject(), id: conv._id, messageCount: 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lấy chi tiết hội thoại + messages
app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id).lean();
    if (!conv) return res.status(404).json({ error: "Not found" });

    const messages = await Message.find({ conversationId: conv._id }).sort({ createdAt: 1 }).lean();

    res.json({
      ...conv,
      id: conv._id,
      messages: messages.map(m => ({ ...m, id: m._id })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Xóa hội thoại
app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await Conversation.findByIdAndDelete(req.params.id);
    await Message.deleteMany({ conversationId: req.params.id });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cập nhật tiêu đề
app.patch("/api/conversations/:id/title", async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ error: "title is required" });

    const conv = await Conversation.findByIdAndUpdate(
      req.params.id,
      { title },
      { new: true }
    ).lean();
    if (!conv) return res.status(404).json({ error: "Not found" });

    const messageCount = await Message.countDocuments({ conversationId: conv._id });
    res.json({ ...conv, id: conv._id, messageCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────

// Lấy danh sách tin nhắn
app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    const messages = await Message
      .find({ conversationId: req.params.id })
      .sort({ createdAt: 1 })
      .lean();
    res.json(messages.map(m => ({ ...m, id: m._id })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gửi tin nhắn → nhận phản hồi AI
app.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const convId = req.params.id;
    const { content, model: reqModel, systemPrompt: reqSystemPrompt } = req.body || {};

    if (!content) return res.status(400).json({ error: "content is required" });

    const conv = await Conversation.findById(convId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    // Lưu tin nhắn người dùng
    await Message.create({ conversationId: convId, role: "user", content });

    // Lấy toàn bộ lịch sử
    const history = await Message.find({ conversationId: convId }).sort({ createdAt: 1 }).lean();

    const model        = reqModel        || conv.model        || DEFAULT_MODEL;
    const systemPrompt = reqSystemPrompt || conv.systemPrompt;

    const groqMessages = [];
    if (systemPrompt) groqMessages.push({ role: "system", content: systemPrompt });
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        groqMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Gọi Groq API
    const completion = await groq.chat.completions.create({
      model,
      messages: groqMessages,
      max_tokens: 4096,
    });

    const aiContent = completion.choices[0]?.message?.content ?? "";
    const tokens    = completion.usage?.completion_tokens ?? null;

    // Lưu phản hồi AI
    const aiMessage = await Message.create({
      conversationId: convId,
      role: "assistant",
      content: aiContent,
      model,
      tokens,
    });

    // Cập nhật thời gian + model của conversation
    await Conversation.findByIdAndUpdate(convId, { model, updatedAt: new Date() });

    // Tự động tạo tiêu đề nếu vẫn là mặc định
    if (conv.title === "New Conversation") {
      try {
        const titleResp = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [{
            role: "user",
            content: `Tạo tiêu đề ngắn gọn (tối đa 6 từ, không dùng dấu ngoặc kép) cho cuộc hội thoại bắt đầu bằng: "${content.substring(0, 200)}"`,
          }],
          max_tokens: 30,
        });
        const generatedTitle = titleResp.choices[0]?.message?.content?.trim();
        if (generatedTitle) {
          await Conversation.findByIdAndUpdate(convId, { title: generatedTitle });
        }
      } catch { /* không quan trọng nếu lỗi */ }
    }

    res.json({ ...aiMessage.toObject(), id: aiMessage._id });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route mặc định trả về index.html ──────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`GroqChat server đang chạy tại http://localhost:${PORT}`);
});
