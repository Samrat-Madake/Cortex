#!/bin/bash
# Record golden input/output test data from the running Cortex service.
# Run this script while the service is up with real data.
# Output: eval/benchmark/fixtures/mem-golden/

set -e

BASE_URL="${CORTEX_URL:-http://localhost:8219}"
OUT_DIR="eval/benchmark/fixtures/mem-golden"
mkdir -p "$OUT_DIR"

echo "Recording golden test data from $BASE_URL ..."
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Health & Status
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[1/12] GET /health"
curl -s "$BASE_URL/health" | python3 -m json.tool > "$OUT_DIR/01-health-response.json"

echo "[2/12] GET /status"
curl -s "$BASE_URL/status" | python3 -m json.tool > "$OUT_DIR/02-status-response.json"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. GET memories (list)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[3/12] GET /memories?camera_id=walk-cam (episodic)"
curl -s "$BASE_URL/memories?camera_id=walk-cam&memory_type=episodic&limit=5" | python3 -m json.tool > "$OUT_DIR/03-get-memories-episodic.json"

echo "[4/12] GET /memories?camera_id=walk-cam (semantic)"
curl -s "$BASE_URL/memories?camera_id=walk-cam&memory_type=semantic&limit=5" | python3 -m json.tool > "$OUT_DIR/04-get-memories-semantic.json"

echo "[5/12] GET /memories?camera_id=global (procedural)"
curl -s "$BASE_URL/memories?camera_id=global&memory_type=procedural&limit=5" | python3 -m json.tool > "$OUT_DIR/05-get-memories-procedural.json"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Search
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[6/12] POST /search (person walking, episodic + semantic)"
curl -s -X POST "$BASE_URL/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"person walking on street","camera_id":"walk-cam","limit":3}' | python3 -m json.tool > "$OUT_DIR/06-search-person-walking.json"

echo "[7/12] POST /search (security risk)"
curl -s -X POST "$BASE_URL/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"security risk suspicious activity","camera_id":"walk-cam","limit":3}' | python3 -m json.tool > "$OUT_DIR/07-search-security-risk.json"

echo "[8/12] POST /search (entity filter)"
# Get an entity_id from the data we already have
ENTITY_ID=$(python3 -c "
import json
with open('$OUT_DIR/03-get-memories-episodic.json') as f:
    d = json.load(f)
for k, v in d.items():
    if isinstance(v, list):
        for m in v:
            eids = m.get('entity_ids', [])
            if eids:
                print(eids[0])
                exit()
print('entity_unknown')
" 2>/dev/null)
echo "  Using entity_id=$ENTITY_ID"
curl -s -X POST "$BASE_URL/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"what did this entity do\",\"entity_id\":\"$ENTITY_ID\",\"limit\":3}" | python3 -m json.tool > "$OUT_DIR/08-search-by-entity.json"

echo "[9/12] POST /search (memory_type=semantic only)"
curl -s -X POST "$BASE_URL/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"appearance behavior pattern","camera_id":"walk-cam","memory_type":"semantic","limit":3}' | python3 -m json.tool > "$OUT_DIR/09-search-semantic-only.json"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. GET single memory by ID
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[10/12] GET /memories/:id"
MEMORY_ID=$(python3 -c "
import json
with open('$OUT_DIR/03-get-memories-episodic.json') as f:
    d = json.load(f)
for k, v in d.items():
    if isinstance(v, list) and v:
        print(v[0]['id'])
        exit()
print('unknown')
" 2>/dev/null)
echo "  Using memory_id=$MEMORY_ID"
curl -s "$BASE_URL/memories/$MEMORY_ID" | python3 -m json.tool > "$OUT_DIR/10-get-memory-by-id.json"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. Qdrant collection configs (baseline for validation)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[11/12] Qdrant collections config"
python3 -c "
import json, urllib.request

collections_url = 'http://localhost:6333/collections'
resp = urllib.request.urlopen(collections_url)
data = json.load(resp)
result = {}
for c in data.get('result', {}).get('collections', []):
    name = c['name']
    info_resp = urllib.request.urlopen(f'http://localhost:6333/collections/{name}')
    info = json.load(info_resp)
    r = info['result']
    result[name] = {
        'points_count': r['points_count'],
        'vector_size': r['config']['params']['vectors']['size'],
        'distance': r['config']['params']['vectors']['distance'],
    }
print(json.dumps(result, indent=2))
" > "$OUT_DIR/11-qdrant-collections-config.json" 2>/dev/null

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. Qdrant raw samples (payload + vector for ReID)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "[12/12] Qdrant raw samples (episodic, semantic, procedural, reid)"
for coll in episodic_trace episodic_entity episodic_schema semantic_entity semantic_context procedural reid_face reid_entity; do
  full_name="visionmem_me_production_${coll}"
  WITH_VECTOR="false"
  if [[ "$coll" == reid_* ]]; then
    WITH_VECTOR="true"
  fi
  curl -s -X POST "http://localhost:6333/collections/${full_name}/points/scroll" \
    -H "Content-Type: application/json" \
    -d "{\"limit\": 5, \"with_payload\": true, \"with_vector\": ${WITH_VECTOR}}" | \
    python3 -m json.tool > "$OUT_DIR/12-qdrant-${coll}-sample.json" 2>/dev/null
done

echo ""
echo "=== Done! Golden data files: ==="
ls -lh "$OUT_DIR/"
echo ""
echo "Total: $(ls "$OUT_DIR/" | wc -l | tr -d ' ') files"
