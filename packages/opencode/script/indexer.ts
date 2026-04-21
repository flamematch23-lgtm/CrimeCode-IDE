import { ChromaClient } from "chromadb";
import { Glob } from "glob";
import fs from "fs/promises";
import path from "path";

async function run() {
  console.log("Starting codebase indexing for vector RAG...");
  const client = new ChromaClient();
  
  const collectionName = "opencode_codebase_local";
  try {
    await client.deleteCollection({ name: collectionName });
  } catch (e) {
    // ignore if it doesn't exist
  }
  
  const collection = await client.createCollection({ name: collectionName });
  console.log(`Created collection: ${collectionName}`);

  const cwd = process.cwd();
  console.log(`Scanning directory: ${cwd}`);
  
  // Use glob to find .ts and .md files, ignoring node_modules
  const files = await new Glob("**/*.{ts,md}", { 
    cwd, 
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"] 
  }).walk();

  let totalDocs = 0;

  const BATCH_SIZE = 100;
  let batchIds: string[] = [];
  let batchDocuments: string[] = [];
  let batchMetadatas: Record<string, any>[] = [];

  const flushBatch = async () => {
    if (batchIds.length > 0) {
      console.log(`Adding ${batchIds.length} chunks to ChromaDB...`);
      await collection.add({
        ids: batchIds,
        documents: batchDocuments,
        metadatas: batchMetadatas
      });
      totalDocs += batchIds.length;
      batchIds = [];
      batchDocuments = [];
      batchMetadatas = [];
    }
  };

  for await (const file of files) {
    if (typeof file !== 'string') continue;
    const filePath = path.join(cwd, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      
      // Simple chunking: split by double newline, or fallback to fixed size
      const chunks = content.split('\n\n').filter(c => c.trim().length > 10);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i].trim();
        // Skip tiny chunks
        if (chunk.length < 20) continue;

        batchIds.push(`${file}_chunk_${i}`);
        batchDocuments.push(chunk);
        batchMetadatas.push({ file });

        if (batchIds.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }
    } catch (e) {
      console.error(`Failed to read/process ${file}:`, e);
    }
  }

  await flushBatch();
  console.log(`Indexing complete! Added ${totalDocs} chunks to ChromaDB.`);
}

run().catch(console.error);
