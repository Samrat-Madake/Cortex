/** Memory-service ReID operations used by perception identity binding. */
export interface MemoryReIdPort {
  reidSearch(embedding: number[], type: "face" | "body"): Promise<Array<{
    entity_id: string;
    score: number;
    type: "face" | "body";
    subject_index?: number | null;
    name?: string | null;
    first_seen?: string | number | null;
    semantic_memories?: string[];
    episodic_memories?: string[];
  }>>;
  reidUpsert(embeddings: {
    face?: { vector: number[]; quality: number; yaw?: number; pitch?: number };
    body?: { vector: number[]; quality: number; body_yaw_ratio?: number; visibility?: string };
  }, identity?: {
    category?: string;
    subject_index?: number;
    name?: string;
    first_seen?: string | number;
  }): Promise<{ entity_id: string; subject_index?: number | null; name?: string | null; first_seen?: string | number | null }>;
  reidUpdateIdentity?(entity_id: string, name: string, identity?: { subject_index?: number }): Promise<void>;
  /** Diversity-aware gallery update for a previously matched entity. */
  reidGalleryUpdate?(entity_id: string, embeddings: {
    face?: { vector: number[]; quality: number; yaw?: number; pitch?: number };
    body?: { vector: number[]; quality: number; body_yaw_ratio?: number; visibility?: string };
  }): Promise<void>;
}
