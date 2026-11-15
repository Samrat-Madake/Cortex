import { setupQdrantBinary } from "../src/services/qdrant-service.js";

setupQdrantBinary()
  .then((qdrant) => {
    console.log(`[qdrant] binary: ${qdrant}`);
  })
  .catch((err: Error) => {
    console.error("[qdrant] Binary setup failed:", err.message);
    process.exit(1);
  });
