// upload-server.js
import express from "express";
import multer from "multer";
import path from "path";
import cors from "cors";
import fs from "fs";
import xlsx from "xlsx";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({ dest: "uploads/" });

// === 1️⃣ SUBIDA Y PREVISUALIZACIÓN ===
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const filePath = req.file.path;

    // Leer archivo Excel
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // Seleccionar solo columnas relevantes (pueden cambiarse según tu Excel)
    const preview = data.map((row) => ({
      Producto: row.Producto || row["Nombre del producto"] || "",
      SKU: row.SKU || row["Código"] || "",
      Precio: row.Precio || row["Precio"] || "",
      Fecha: row.Fecha || new Date().toISOString().split("T")[0],
    }));

    // Borrar el archivo temporal
    fs.unlinkSync(filePath);

    // Enviar previsualización al frontend
    res.json({ preview });
  } catch (error) {
    console.error("Error procesando archivo:", error);
    res.status(500).json({ error: "Error procesando archivo" });
  }
});

// === 2️⃣ CONFIRMACIÓN DE ACTUALIZACIÓN ===
app.post("/confirm", (req, res) => {
  const { data } = req.body;

  // ⚙️ Aquí iría tu lógica real de actualización (API, BD, etc.)
  // Por ahora solo simulamos:
  console.log("Datos confirmados:", data);

  res.json({ message: "Actualización confirmada correctamente" });
});

// === 3️⃣ DEFAULT ROUTE ===
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor funcionando en el puerto ${PORT}`);
});
