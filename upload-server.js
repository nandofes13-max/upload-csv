// upload-server.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const xlsx = require("xlsx");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({ dest: "uploads/" });

// --- Helpers ---
// Convierte Excel strings a "DD/MM/AA" como texto
function toDDMMYY(raw) {
  if (raw === null || raw === undefined || raw === "") return "";

  // Si ya viene como Date → convertir a texto
  if (raw instanceof Date) {
    const dd = String(raw.getDate()).padStart(2, "0");
    const mm = String(raw.getMonth() + 1).padStart(2, "0");
    const yy = String(raw.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }

  // Si viene string dd/mm/yy o dd/mm/yyyy
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yy = m[3].length === 4 ? m[3].slice(-2) : m[3];
    return `${dd}/${mm}/${yy}`;
  }

  // fallback: devolver tal cual
  return s;
}

// Crear cliente Jumpseller con Basic Auth
function createJumpsellerClient() {
  const login = process.env.JUMPS_LOGIN;
  const token = process.env.JUMPS_TOKEN;
  if (!login || !token) throw new Error("Faltan JUMPS_LOGIN o JUMPS_TOKEN.");
  return axios.create({
    baseURL: "https://api.jumpseller.com/v1",
    auth: { username: login, password: token },
    timeout: 30_000
  });
}

// Normalizar producto de API Jumpseller
function normalizeProductFromApi(obj) {
  const id = obj.id || obj.product_id || obj.product?.id || obj.id_product || null;
  const name = obj.name || obj.title || (obj.product && (obj.product.name || obj.product.title)) || "";
  const sku = obj.sku || obj.sku_code || (obj.variants && obj.variants[0]?.sku) || "";
  const price = obj.price || obj.price_with_currency || (obj.variants && obj.variants[0]?.price) || "";
  return { id, name, sku, price };
}

// ------------------
// RUTA: subida y previsualización
// ------------------
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió archivo" });

  const filePath = req.file.path;
  try {
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    const jsClient = createJumpsellerClient();
    const preview = [];

    for (const row of rawRows) {
      const keys = {};
      for (const k of Object.keys(row)) keys[k.toLowerCase().trim()] = row[k];

      const skuRaw = keys["cod.int"] ?? keys["cod int"] ?? keys["codint"] ?? keys["codigo"] ?? keys["codigo interno"] ?? keys["cod"];
      const sku = skuRaw?.toString().trim() || "";

      // Precio como decimal
      const precioRaw = keys["precio"] || keys["price"] || keys["importe"] || 0;
      const precio = Number(String(precioRaw).replace(/[^\d\.,-]/g, "").replace(",", ".")) || 0;

      // Fecha como texto
      const fechaRaw = keys["fecha"] || keys["fecha actualizacion"] || keys["fecha actualización"] || keys["fecha_modificacion"] || "";
      const fecha = toDDMMYY(fechaRaw);

      // Buscar producto en Jumpseller
      let apiProduct = null;
      try {
        const resp = await jsClient.get(`/products/search.json`, {
