

// ========================= Built-in Dropdown =========================
document.addEventListener("DOMContentLoaded", () => {
  const builtinSelect = document.getElementById("builtinSelect");
  const loadBuiltin = document.getElementById("loadBuiltin");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  if (typeof window.getAllTestImageNames === "function") {
    const names = window.getAllTestImageNames();
    builtinSelect.innerHTML = '<option value="">-- Select built-in image --</option>';
    names.forEach((n) => {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      builtinSelect.appendChild(opt);
    });
  } else {
    alert("⚠️ Built-in image library not loaded. Check test-images.js inclusion.");
  }

  async function drawImageToCanvas(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = (err) => reject(err);
      img.src = b64;
    });
  }

  loadBuiltin.addEventListener("click", async () => {
    const name = builtinSelect.value;
    if (!name) return alert("Please select a built-in image first.");
    const dataUrl = window.loadTestImage(name);
    if (!dataUrl) return alert("Image not found!");

    try {
      await drawImageToCanvas(dataUrl);
      console.log(`✅ Loaded built-in image: ${name}`);
    } catch (err) {
      console.error("Image load failed", err);
      alert("⚠️ Failed to load image. Please try again.");
    }
  });
});

// ========================== Upload Image Logic ==========================
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("⚠️ Please upload a valid image file (PNG, JPG, etc.)");
      return;
    }

    try {
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        console.log("✅ Uploaded image:", file.name);
      };
      img.onerror = () => alert("⚠️ Failed to load image.");
      img.src = dataURL;
    } catch (err) {
      console.error("Error reading file:", err);
      alert("⚠️ Error loading image.");
    }
  });
});

// =========================== Shape Detection ===========================
function detectShapes(canvas) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  if (w === 0 || h === 0) {
    alert("⚠️ Load or upload an image first!");
    return { shapes: [] };
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  const gray = toGray(imgData);
  const bin = thresholdImage(gray, w, h, 128);
  const comps = connectedComponents(bin, w, h);
  const shapes = [];

  for (const comp of comps) {
    if (comp.length < 50) continue;

    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (const idx of comp) {
      const y = Math.floor(idx / w), x = idx % w;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const bounding_box = { x: minX, y: minY, width: bw, height: bh };
    const center = { x: minX + bw / 2, y: minY + bh / 2 };

    const boundary = boundaryFromComponent(comp, w, h);
    if (boundary.length < 6) continue;
    const hull = convexHull(boundary);
    let approx = rdp(hull, Math.max(2, Math.round(Math.min(bw, bh) * 0.03)));

    const per = polygonPerimeter(hull);
    const area = polygonArea(hull) || comp.length;
    const hullArea = polygonArea(hull) || area;
    const circularity = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
    const verts = approx.length;

    // concavity count on approx (relative sign may vary): count negative cross products
    let concave = 0;
    for (let i = 0; i < verts; i++) {
      const a = approx[(i - 1 + verts) % verts];
      const b = approx[i];
      const c = approx[(i + 1) % verts];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross < 0) concave++;
    }

    // solidity: how filled is the polygon compared to convex hull
    const solidity = hullArea > 0 ? area / hullArea : 1.0;

    // additional helpers for quads
    function quadIsSquareOrRect(pts) {
      if (pts.length !== 4) return null;
      // compute side lengths and angles
      const sides = [];
      const angles = [];
      for (let i = 0; i < 4; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % 4];
        const p2 = pts[(i + 2) % 4];
        const vx = p1.x - p0.x, vy = p1.y - p0.y;
        const wx = p2.x - p1.x, wy = p2.y - p1.y;
        sides.push(Math.hypot(vx, vy));
        // angle at p1 between v and w
        const dot = vx * wx + vy * wy;
        const mag = Math.hypot(vx, vy) * Math.hypot(wx, wy) || 1;
        const cos = Math.max(-1, Math.min(1, dot / mag));
        const angDeg = Math.acos(cos) * 180 / Math.PI;
        angles.push(angDeg);
      }
      const avgSide = sides.reduce((a,b)=>a+b,0)/sides.length;
      const sideRatio = Math.max(...sides)/Math.min(...sides);
      const angDeviation = angles.map(a=>Math.abs(a-90)).reduce((a,b)=>a+b,0)/angles.length;
      return { sideRatio, angDeviation, avgSide };
    }

    // classification with tuned thresholds
    let type = "polygon";
    let confidence = 0.5;

    // 1️⃣ Circle test 
    if (circularity > 0.90 && Math.abs(bw - bh) < Math.min(bw, bh) * 0.08 && solidity > 0.92) {
    type = "circle";
    confidence = 0.96;
    }

    // 2️⃣ Triangle
    else if (verts === 3) {
    type = "triangle";
    confidence = 0.95;
    }

    // 3️⃣ Quad detection — distinguish square/rectangle vs round
    else if (verts === 4) {
    const quadInfo = quadIsSquareOrRect(approx);
    if (quadInfo) {
        const { sideRatio, angDeviation } = quadInfo;
        if (angDeviation < 15 && sideRatio < 1.2) {
        type = "square";
        confidence = 0.96;
        } else {
        type = "rectangle";
        confidence = 0.88;
        }
    }
    }
    else if (
    verts >= 8 &&
    concaveRatio > 0.15 &&
    solidity < 0.78 &&
    circularity < 0.72 &&
    angleVariance > 400
    ) {
    type = "star";
    confidence = 0.85 + (0.1 * Math.min(concaveRatio * 5, 0.2));
    }


    //  ⭐️ STAR DETECTION 
    else if (verts >= 8) {
      let concaveCount = 0;
      const pts = approx;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[i];
        const c = pts[(i + 1) % pts.length];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (cross < 0) concaveCount++;
      }

      if (concaveCount >= Math.max(2, Math.round(0.15 * verts))) {
        type = "star";
        confidence = 0.8 + Math.min(0.1, concaveCount / verts);
      }
    }
        // 4️⃣ Pentagon
    else if ((verts >= 5 && verts <= 7) && circularity > 0.68 && circularity < 0.90 && solidity > 0.8) {
    type = "pentagon";
    confidence = 0.9 - Math.abs(verts - 5) * 0.05;
    console.log(circularity)
    }

    else {
    if (circularity > 0.65 && verts > 6) {
        type = "circle-ish";
        confidence = 0.7;
    } else {
        type = "polygon";
        confidence = Math.min(0.85, 0.4 + verts / 12);
    }
    }


    shapes.push({
      type,
      confidence: Math.round(confidence * 100) / 100,
      bounding_box,
      center,
      area: Math.round(area),
      vertices: approx
    });
  }

  return { shapes };
}

// ====================== Helper Functions ======================
function toGray(imgData) {
  const { data, width, height } = imgData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

function thresholdImage(gray, w, h, thresh = 128) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) bin[i] = gray[i] < thresh ? 1 : 0;
  return bin;
}

function connectedComponents(bin, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  let current = 0;
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || labels[i]) continue;
    current++;
    const stack = [i];
    labels[i] = current;
    const comp = [];
    while (stack.length) {
      const idx = stack.pop();
      comp.push(idx);
      const y = Math.floor(idx / w);
      const x = idx % w;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          const nx = x + xx, ny = y + yy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (bin[ni] && !labels[ni]) {
            labels[ni] = current;
            stack.push(ni);
          }
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function boundaryFromComponent(pixels, w, h) {
  const set = new Set(pixels);
  const boundary = [];
  for (const idx of pixels) {
    const y = Math.floor(idx / w);
    const x = idx % w;
    let edge = false;
    for (let yy = -1; yy <= 1 && !edge; yy++) {
      for (let xx = -1; xx <= 1 && !edge; xx++) {
        if (xx === 0 && yy === 0) continue;
        const nx = x + xx, ny = y + yy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (!set.has(ny * w + nx)) edge = true;
      }
    }
    if (edge) boundary.push({ x, y });
  }
  return boundary;
}

function convexHull(points) {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function rdp(points, eps) {
  if (!points || points.length < 3) return points ? points.slice() : [];
  function perp(a, b, p) {
    const num = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x);
    const den = Math.hypot(b.y - a.y, b.x - a.x);
    return den === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : num / den;
  }
  let dmax = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perp(points[0], points[points.length - 1], points[i]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function polygonPerimeter(pts) {
  if (!pts || pts.length === 0) return 0;
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    p += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return p;
}

function polygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

// ========================= Draw Detected Shapes =========================
function drawDetectedShapes(canvas, result) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.putImageData(imageData, 0, 0);

  result.shapes.forEach((s) => {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.strokeRect(s.bounding_box.x, s.bounding_box.y, s.bounding_box.width, s.bounding_box.height);

    if (s.vertices && s.vertices.length > 2) {
      ctx.beginPath();
      ctx.moveTo(s.vertices[0].x, s.vertices[0].y);
      for (let i = 1; i < s.vertices.length; i++) ctx.lineTo(s.vertices[i].x, s.vertices[i].y);
      ctx.closePath();

      const colorMap = {
        circle: "#3b82f6",
        triangle: "#eab308",
        rectangle: "#a855f7",
        pentagon: "#ef4444",
        star: "#f97316",
        polygon: "#94a3b8"
      };
      ctx.strokeStyle = colorMap[s.type] || "#fff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(s.bounding_box.x, s.bounding_box.y - 18, 140, 18);
    ctx.fillStyle = "#fff";
    ctx.font = "13px 'Inter', sans-serif";
    ctx.fillText(`${s.type} (${Math.round(s.confidence * 100)}%)`, s.bounding_box.x + 4, s.bounding_box.y - 5);
  });
}

// ========================= Detect Button =========================
document.getElementById("detectBtn").addEventListener("click", () => {
  const canvas = document.getElementById("canvas");
  const result = detectShapes(canvas);
  drawDetectedShapes(canvas, result);
  console.log("Detected shapes:", result.shapes);
});
