import express from "express";
import cors from "cors";
import OpenAI from "openai"; // DeepSeek dùng OpenAI SDK
import mongoose from "mongoose";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/deepseekchat";

// ─── DeepSeek client ──────────────────────────────────────────────────────────────
// DeepSeek dùng baseURL riêng và API key từ platform.deepseek.com
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY, // Biến môi trường DEEPSEEK_API_KEY
  baseURL: "https://api.deepseek.com/v1", // Endpoint của DeepSeek
});

// ─── SYSTEM PROMPT MẶC ĐỊNH - NHÂN CÁCH AI ────────────────────────────────────
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
  useCustomPrompt: { type: Boolean, default: false },
}, { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } });

const Message      = mongoose.model("Message",      messageSchema);
const Conversation = mongoose.model("Conversation", conversationSchema);

// ─── Kết nối MongoDB ──────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("🦀 MongoDB connected:", MONGO_URI))
  .catch(err => { console.error("MongoDB connection error:", err.message); process.exit(1); });

// ─── Models DeepSeek có sẵn ───────────────────────────────────────────────────────
// DeepSeek cung cấp các model chính
const AVAILABLE_MODELS = [
  { id: "deepseek-chat",        name: "DeepSeek Chat",        contextWindow: 64000 },
  { id: "deepseek-coder",       name: "DeepSeek Coder",       contextWindow: 64000 },
  { id: "deepseek-chat-1.5",    name: "DeepSeek Chat 1.5",    contextWindow: 64000 },
  { id: "deepseek-coder-1.5",   name: "DeepSeek Coder 1.5",   contextWindow: 64000 },
];

const DEFAULT_MODEL = "deepseek-chat";

app.use(cors());
app.use(express.json());

// ─── Phục vụ file HTML tĩnh ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '.')));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok", creator: "Kieu Thanh Hai (CRABOR Founder)" });
});

// ─── Thông tin về AI và người tạo ─────────────────────────────────────────────
app.get("/api/about", (_req, res) => {
  res.json({
    name: "CRAB AI Assistant (Powered by DeepSeek)",
    creator: {
      fullName: "Kiều Thanh Hải",
      role: "Founder, Sole Developer & PM of CRABOR",
      university: "Đại học Đại Nam - Logistics năm 2",
      projects: ["CRABOR Super App", "Mindustry Plugins", "PocketMine-MP Plugins"]
    },
    brand: {
      name: "CRABOR",
      colors: ["#E8504A (coral-red)", "#FFFDD0 (cream)"],
      mascot: "Crab with big round eyes",
      style: "Cute, friendly, playful"
    },
    version: "2.0 - with Hải's persona on DeepSeek"
  });
});

// ─── Models ───────────────────────────────────────────────────────────────────
app.get("/api/models", (_req, res) => {
  res.json(AVAILABLE_MODELS);
});

// ─── Conversations ────────────────────────────────────────────────────────────

// Lấy danh sách hội thoại
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
    const { title = "New Conversation", model = null, systemPrompt = null, useCustomPrompt = false } = req.body || {};
    const conv = await Conversation.create({ 
      title, 
      model, 
      systemPrompt: useCustomPrompt ? systemPrompt : null,
      useCustomPrompt 
    });
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

// Gửi tin nhắn → nhận phản hồi AI (đã tích hợp nhân cách Hải)
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

    const model = reqModel || conv.model || DEFAULT_MODEL;
    
    // QUAN TRỌNG: Chọn system prompt
    let systemPrompt;
    if (conv.useCustomPrompt && reqSystemPrompt) {
      systemPrompt = reqSystemPrompt;
    } else if (conv.systemPrompt && conv.useCustomPrompt) {
      systemPrompt = conv.systemPrompt;
    } else {
      systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }

    const deepseekMessages = [];
    if (systemPrompt) deepseekMessages.push({ role: "system", content: systemPrompt });
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        deepseekMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Gọi DeepSeek API (tương thích OpenAI SDK)
    const completion = await deepseek.chat.completions.create({
      model: model,
      messages: deepseekMessages,
      max_tokens: 4096,
      temperature: 0.7,
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
        const titleResp = await deepseek.chat.completions.create({
          model: "deepseek-chat",
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

// ─── Endpoint đặc biệt: Hỏi về Hải hoặc CRABOR ─────────────────────────────────
app.post("/api/ask-about-hai", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });

    const response = await deepseek.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: question }
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    res.json({ answer: response.choices[0]?.message?.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route mặc định trả về index.html ──────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🦀 CRAB AI Server (DeepSeek) đang chạy tại http://localhost:${PORT}`);
  console.log(`🦀 AI được tạo ra bởi Kiều Thanh Hải (Founder CRABOR)`);
});
