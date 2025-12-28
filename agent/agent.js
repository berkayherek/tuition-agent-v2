import express from 'express';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL; // Your Render API URL (Group 2)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Firebase Admin (Using Env Var for credentials on Render)
// IMPORTANT: process.env.FIREBASE_SERVICE_ACCOUNT must be a JSON string
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- TOOL DEFINITIONS ---

// Define tools for the model to use
const checkTuitionTool = {
  name: 'check_tuition',
  parameters: {
    type: Type.OBJECT,
    description: 'Check the outstanding tuition fee for a student.',
    properties: {
      student_id: {
        type: Type.STRING,
        description: 'The ID of the student to check.',
      },
    },
    required: ['student_id'],
  },
};

const payTuitionTool = {
  name: 'pay_tuition',
  parameters: {
    type: Type.OBJECT,
    description: 'Process a tuition payment for a student.',
    properties: {
      student_id: {
        type: Type.STRING,
        description: 'The ID of the student paying.',
      },
      amount: {
        type: Type.NUMBER,
        description: 'The amount to pay.',
      },
    },
    required: ['student_id', 'amount'],
  },
};

// --- AGENT LOGIC ---

// Helper to execute tools via your existing API
async function executeTool(name, args) {
  console.log(`[Tool Execution] Calling ${name} with`, args);
  try {
    let response;
    // Map tool names to your actual API endpoints
    // Adjust paths ('/tuition/check', etc.) to match your actual Group 2 API routes
    if (name === 'check_tuition') {
      // Assuming GET /tuition/:id or POST /tuition/check
      response = await axios.get(`${API_URL}/tuition/${args.student_id}`);
    } else if (name === 'pay_tuition') {
      // Assuming POST /tuition/pay
      response = await axios.post(`${API_URL}/tuition/pay`, {
        student_id: args.student_id,
        amount: args.amount
      });
    } else {
      return { error: 'Unknown tool' };
    }
    return response.data;
  } catch (error) {
    console.error(`[Tool Error] ${name} failed:`, error.message);
    return { error: `API Call Failed: ${error.message}` };
  }
}

// Listen to Firestore for new messages
// We listen to the 'chats' collection.
const setupFirestoreListener = () => {
  console.log("Starting Firestore listener on 'chats' collection...");
  
  // Listen for changes where processed == false (or undefined)
  // Note: Firestore '!=' queries are limited, so we handle filtering in code if needed, 
  // but simpler to listen to everything added and check flags.
  db.collection('chats').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const messageData = change.doc.data();
        const docId = change.doc.id;

        // Only process User messages that haven't been processed yet
        if (messageData.role === 'user' && !messageData.processed) {
          console.log(`[New Message] processing doc ${docId}: "${messageData.text}"`);
          
          // 1. Mark as processing immediately to prevent loops/race conditions
          await db.collection('chats').doc(docId).update({ processed: true });

          try {
            // 2. Prepare Context for Gemini
            // In a real app, we would fetch previous messages for history. 
            // Here we send the current prompt for simplicity.
            
            const systemInstruction = `You are a helpful tuition assistant for a Tuition Centre. 
            You can help check outstanding fees and process payments.
            ALWAYS ask for the 'student_id' if it is not provided before using a tool.
            Use the provided tools 'check_tuition' and 'pay_tuition' when necessary.`;

            // 3. Call Gemini
            let modelResponse = await ai.models.generateContent({
              model: 'gemini-2.5-flash-preview-09-2025', // Or 'gemini-2.5-flash-latest'
              contents: [{ role: 'user', parts: [{ text: messageData.text }] }],
              config: {
                systemInstruction: systemInstruction,
                tools: [{ functionDeclarations: [checkTuitionTool, payTuitionTool] }]
              }
            });

            // 4. Handle Tool Calls (Multi-turn loop)
            // Note: The new SDK structure puts functionCalls inside candidates[0].content.parts
            let finalResponseText = "";
            
            const candidates = modelResponse.candidates;
            if (candidates && candidates[0].content && candidates[0].content.parts) {
              const parts = candidates[0].content.parts;
              
              // Check for function calls
              const functionCalls = parts.filter(part => part.functionCall).map(part => part.functionCall);
              
              if (functionCalls.length > 0) {
                // Execute tools
                const toolOutputs = [];
                for (const call of functionCalls) {
                  const result = await executeTool(call.name, call.args);
                  toolOutputs.push({
                     functionResponse: {
                        name: call.name,
                        response: { result: result } 
                     }
                  });
                }

                // Send tool outputs back to Gemini for final natural language response
                const secondResponse = await ai.models.generateContent({
                  model: 'gemini-2.5-flash-preview-09-2025',
                  contents: [
                    { role: 'user', parts: [{ text: messageData.text }] },
                    { role: 'model', parts: parts }, // The original model response with function calls
                    { role: 'function', parts: toolOutputs } // The results
                  ],
                  config: { systemInstruction: systemInstruction }
                });

                finalResponseText = secondResponse.text;
              } else {
                // No tools used, just get text
                finalResponseText = modelResponse.text;
              }
            }

            // 5. Write response to Firestore
            if (finalResponseText) {
              await db.collection('chats').add({
                text: finalResponseText,
                role: 'model',
                createdAt: new Date(),
                relatedToMessageId: docId
              });
              console.log(`[Reply Sent]`);
            }

          } catch (err) {
            console.error("Error generating AI response:", err);
            await db.collection('chats').add({
              text: "I'm sorry, I encountered an error processing your request.",
              role: 'model',
              createdAt: new Date()
            });
          }
        }
      }
    });
  });
};

// --- EXPRESS SERVER (Keep-Alive) ---

const app = express();

// Basic health check route
app.get('/', (req, res) => {
  res.send('Agent is running and listening to Firestore.');
});

app.listen(PORT, () => {
  console.log(`Agent server listening on port ${PORT}`);
  setupFirestoreListener();
});