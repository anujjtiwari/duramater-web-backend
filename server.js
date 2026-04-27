const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// MONGODB SETUP
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));


// ==========================================
// SCHEMAS (FIXED ORDER)
// ==========================================

// ✅ Define this FIRST
const ReportSchema = new mongoose.Schema({
  reportDate: { type: String, required: true },
  fileUrl: { type: String },
  hostFactors: { type: Array, default: [] },
  uploadedAt: { type: Date, default: Date.now }
});

// Then use it here
const HealthProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  hostFactors: { type: Array, default: [] },
  age: { type: Number, default: null },
  lastUpdated: { type: Date, default: Date.now },
  reports: [ReportSchema]
});

const HealthProfile = mongoose.model('HealthProfile', HealthProfileSchema);


// ==========================================
// HELPER FUNCTION
// ==========================================
function fileToGenerativePart(buffer, mimeType) {
  return { inlineData: { data: buffer.toString("base64"), mimeType } };
}


// ==========================================
// ROUTES
// ==========================================

// 0. Health Check
app.get('/', (req, res) => {
  res.send('Sapiens Backend is running smoothly on Render! 🚀');
});


// 1. Fetch User Data
app.get('/api/health-profile/:userId', async (req, res) => {
  try {
    const profile = await HealthProfile.findOne({ userId: req.params.userId });

    if (!profile) {
      return res.status(404).json({ message: 'No profile found' });
    }

    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});


// 2. Upload and Analyze
app.post('/api/analyze-report', upload.single('report'), async (req, res) => {
  try {
    console.log('\n--- 📥 NEW UPLOAD REQUEST ---');

    if (!req.file) {
      return res.status(400).json({ error: 'No report file uploaded' });
    }

    const userId = req.body.userId;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    console.log(`👤 User ID: ${userId}`);
    console.log(`📄 File: ${req.file.originalname}`);

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const documentPart = fileToGenerativePart(req.file.buffer, req.file.mimetype);

    const prompt = `
      You are an expert medical AI. Analyze this health report and extract all biomarkers.
      Categorize them into organ systems.

      Return ONLY raw JSON in this format:
      {
        "hostFactors": [
          {
            "organ": "String",
            "status": "optimal" | "normal" | "warning" | "high",
            "markers": [
              {
                "name": "String",
                "value": "String",
                "unit": "String",
                "indicator": "Optimal" | "Normal" | "High" | "Low",
                "range": "String"
              }
            ]
          }
        ]
      }
    `;

    const result = await model.generateContent([prompt, documentPart]);

    // ✅ Safer JSON extraction
    let text = result.response.text();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsedData;
    try {
      parsedData = JSON.parse(text);
    } catch (err) {
      console.error("❌ JSON parse failed:", text);
      return res.status(500).json({
        error: "Invalid JSON returned from AI",
        raw: text
      });
    }

    console.log('💾 Saving to MongoDB...');

    // ✅ Save + push report history
    const updatedProfile = await HealthProfile.findOneAndUpdate(
      { userId },
      {
        hostFactors: parsedData.hostFactors,
        lastUpdated: new Date(),
        $push: {
          reports: {
            reportDate: new Date().toISOString(),
            hostFactors: parsedData.hostFactors
          }
        }
      },
      { upsert: true, new: true }
    );

    console.log('🎉 Success!');
    res.json(updatedProfile);

  } catch (error) {
    console.error("❌ Server Error:", error);
    res.status(500).json({
      error: 'Failed to analyze and save the report.',
      details: error.message
    });
  }
});


// 3. Delete User Data
app.delete('/api/health-profile/:userId', async (req, res) => {
  try {
    const deletedProfile = await HealthProfile.findOneAndDelete({
      userId: req.params.userId
    });

    if (!deletedProfile) {
      return res.status(404).json({ message: 'No profile found' });
    }

    res.json({ message: 'Data deleted successfully' });

  } catch (error) {
    res.status(500).json({ error: 'Delete failed' });
  }
});


// 4. Save User Age
app.post('/api/health-profile/:userId/age', async (req, res) => {
  try {
    const { age } = req.body;

    if (!age) {
      return res.status(400).json({ error: 'Age is required' });
    }

    const updatedProfile = await HealthProfile.findOneAndUpdate(
      { userId: req.params.userId },
      { age },
      { upsert: true, new: true }
    );

    res.json(updatedProfile);

  } catch (error) {
    res.status(500).json({ error: 'Failed to save age' });
  }
});


// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 DuraMater API running on port ${PORT}`);
});