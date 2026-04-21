import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./vector_rag.txt"

export const VectorRagTool = Tool.define("vector_rag", async () => {
  return {
    get description() {
      return DESCRIPTION
    },
    parameters: z.object({
      query: z.string().describe("Natural language query to search the codebase conceptually"),
      maxResults: z.number().optional().describe("Number of snippets to return (default: 5)"),
    }),
    async execute(params, ctx) {
      await ctx.ask({
        permission: "vector_rag",
        patterns: [params.query],
        always: ["*"],
        metadata: {
          query: params.query,
          maxResults: params.maxResults,
        },
      })

      try {
        const { ChromaClient } = await import("chromadb")
        const client = new ChromaClient()
        const collectionName = `opencode_codebase_local`

        try {
          const collection = await client.getCollection({ name: collectionName })

          const results = await collection.query({
            queryTexts: [params.query],
            nResults: params.maxResults || 5,
          })

          if (
            !results.documents ||
            results.documents.length === 0 ||
            !results.documents[0] ||
            results.documents[0].length === 0
          ) {
            return {
              output: "No semantic matches found. The index might be empty or the query yielded no results.",
              title: `Semantic Search: ${params.query}`,
              metadata: { count: 0, error: false },
            }
          }

          let outputStr = "Semantic matches found:\n\n"
          for (let i = 0; i < results.documents[0].length; i++) {
            const doc = results.documents[0][i]
            const meta = results.metadatas?.[0]?.[i] as Record<string, any> | undefined

            if (meta && meta.file) {
              outputStr += `--- Match ${i + 1} (File: ${meta.file}) ---\n`
            } else {
              outputStr += `--- Match ${i + 1} ---\n`
            }
            outputStr += `${doc}\n\n`
          }

          return {
            output: outputStr,
            title: `Semantic Search: ${params.query}`,
            metadata: { count: results.documents[0].length, error: false },
          }
        } catch (e) {
          return {
            output:
              "Error: The vector collection for this workspace does not exist yet or ChromaDB is not running locally.\n\nTo fix this, you should execute: `cd packages/opencode && bun run index-codebase` via the bash tool to index the codebase first, then try your search again.",
            title: `Semantic Search Error`,
            metadata: { count: 0, error: true },
          }
        }
      } catch (err: any) {
        return {
          output: `Error executing semantic search: ${err.message}`,
          title: `Semantic Search Failed`,
          metadata: { count: 0, error: true },
        }
      }
    },
  }
})
