import express from "express";
import cors from "cors";
import mongoose from "mongoose";

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/cloudflarechat";

// Cloudflare API endpoint
const CLOUDFLARE_API_URL = "https://llm-chat-app-template.djthewolf9.workers.dev";

// ─── Default System Prompt cho CRAB ──────────────────────────────────────────
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
}, { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } });

const Message      = mongoose.model("Message",      messageSchema);
const Conversation = mongoose.model("Conversation", conversationSchema);

// ─── Kết nối MongoDB ──────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected:", MONGO_URI))
  .catch(err => { console.error("MongoDB connection error:", err.message); process.exit(1); });

// ─── Models có sẵn ──────────────────────────────────────────────────────────
const AVAILABLE_MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B", contextWindow: 128000 },
  { id: "@cf/meta/llama-3.1-8b-instruct",  name: "Llama 3.1 8B",   contextWindow: 128000 },
  { id: "@cf/mistral/mistral-7b-instruct", name: "Mistral 7B",     contextWindow: 32768  },
  { id: "@cf/meta/llama-2-7b-chat-int8",   name: "Llama 2 7B",     contextWindow: 4096   },
  { id: "@cf/qwen/qwen1.5-14b-chat-awq",   name: "Qwen 1.5 14B",   contextWindow: 32768  },
];

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct";

app.use(cors());
app.use(express.json());

// Helper function để gọi Cloudflare API
async function callCloudflareAPI(messages, model, systemPrompt = null) {
  const fullMessages = [];
  
  if (systemPrompt) {
    fullMessages.push({ role: "system", content: systemPrompt });
  }
  fullMessages.push(...messages);

  const response = await fetch(CLOUDFLARE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: fullMessages,
      model: model,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare API error: ${response.statusText}`);
  }

  const data = await response.json();
  
  // Định dạng response để tương thích với cấu trúc cũ
  return {
    content: data.response || data.message?.content || "",
    usage: {
      completion_tokens: data.usage?.completion_tokens || null,
    },
  };
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Models ───────────────────────────────────────────────────────────────────
app.get("/api/models", (_req, res) => {
  res.json(AVAILABLE_MODELS);
});

// ─── Conversations ────────────────────────────────────────────────────────────
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

app.post("/api/conversations", async (req, res) => {
  try {
    const { title = "New Conversation", model = null, systemPrompt = null } = req.body || {};
    // Nếu không có systemPrompt được truyền vào, sử dụng DEFAULT_SYSTEM_PROMPT
    const finalSystemPrompt = systemPrompt !== undefined ? systemPrompt : DEFAULT_SYSTEM_PROMPT;
    const conv = await Conversation.create({ title, model, systemPrompt: finalSystemPrompt });
    res.status(201).json({ ...conv.toObject(), id: conv._id, messageCount: 0 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await Conversation.findByIdAndDelete(req.params.id);
    await Message.deleteMany({ conversationId: req.params.id });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Gửi tin nhắn → nhận phản hồi AI từ Cloudflare
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
    // Ưu tiên systemPrompt từ request, nếu không thì lấy từ conversation, cuối cùng là default
    const systemPrompt = reqSystemPrompt !== undefined 
      ? reqSystemPrompt 
      : (conv.systemPrompt !== undefined && conv.systemPrompt !== null 
          ? conv.systemPrompt 
          : DEFAULT_SYSTEM_PROMPT);

    // Chuẩn bị messages cho Cloudflare (chỉ lấy user và assistant)
    const cloudflareMessages = [];
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        cloudflareMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Gọi Cloudflare API
    const { content: aiContent, usage } = await callCloudflareAPI(
      cloudflareMessages,
      model,
      systemPrompt
    );

    const tokens = usage?.completion_tokens ?? null;

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
        const { content: generatedTitle } = await callCloudflareAPI(
          [{
            role: "user",
            content: `Tạo tiêu đề ngắn gọn (tối đa 6 từ, không dùng dấu ngoặc kép) cho cuộc hội thoại bắt đầu bằng: "${content.substring(0, 200)}"`,
          }],
          "@cf/meta/llama-3.1-8b-instruct",
          null // Không cần system prompt cho title generation
        );
        
        if (generatedTitle) {
          const cleanTitle = generatedTitle.trim().replace(/["']/g, '');
          await Conversation.findByIdAndUpdate(convId, { title: cleanTitle });
        }
      } catch (err) {
        console.error("Title generation error:", err.message);
      }
    }

    res.json({ ...aiMessage.toObject(), id: aiMessage._id });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🦀 CRAB - CloudflareChat server đang chạy tại http://localhost:${PORT}`);
  console.log(`Default System Prompt đã được cấu hình cho CRAB AI Assistant`);
});
