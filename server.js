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

// Define the Schema for the user's health profile
const HealthProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  hostFactors: { type: Array, default: [] },
  lastUpdated: { type: Date, default: Date.now }
});

const HealthProfile = mongoose.model('HealthProfile', HealthProfileSchema);

// Helper function for Gemini
function fileToGenerativePart(buffer, mimeType) {
  return { inlineData: { data: buffer.toString("base64"), mimeType } };
}

// ==========================================
// API ROUTES
// ==========================================

// 1. Fetch User Data Route
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

// 2. Upload and Analyze Route
app.post('/api/analyze-report', upload.single('report'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No report file uploaded' });
    
    // We need to know who this report belongs to
    const userId = req.body.userId; 
    if (!userId) return res.status(400).json({ error: 'User ID is required' });

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const documentPart = fileToGenerativePart(req.file.buffer, req.file.mimetype);

    const prompt = `
      You are an expert medical AI. Analyze this health report and extract all biomarkers.
      Categorize them into human body organ systems (e.g., 'Heart', 'Liver', 'Pancreas', 'Kidneys', 'Thyroid').
      Evaluate the overall status of that organ based on the markers.
      
      You MUST return exactly a raw JSON object (no markdown formatting, no codeblocks) matching this schema:
      {
        "hostFactors": [
          {
            "organ": "String",
            "status": "optimal" | "normal" | "warning" | "high",
            "markers": [
              { "name": "String", "value": "String", "unit": "String", "indicator": "Optimal" | "Normal" | "High" | "Low" }
            ]
          }
        ]
      }
    `;

    // Send to Gemini
    const result = await model.generateContent([prompt, documentPart]);
    const cleanJson = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedData = JSON.parse(cleanJson);

    // Save/Update in MongoDB Atlas
    const updatedProfile = await HealthProfile.findOneAndUpdate(
      { userId: userId }, // Find by this user's ID
      { 
        hostFactors: parsedData.hostFactors,
        lastUpdated: new Date()
      },
      { upsert: true, new: true } // Creates a new document if one doesn't exist
    );

    // Return the updated profile to the frontend
    res.json(updatedProfile);

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: 'Failed to analyze and save the report.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Haversian API running on port ${PORT}`));