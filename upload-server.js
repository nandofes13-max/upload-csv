// -----------------------------
// upload-server.js
// -----------------------------
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx"); // ✅ para leer archivos Excel (.xls / .xlsx)
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Servir el formulario desde /public
// -----------------------------
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// Configuración de Multer (subidas)
// -----------------------------
const upload = multer({ dest: "uploads/" });

// -----------------------------
// Ruta principal: muestra el formulario HTML
// -----------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------
// Procesamiento del archivo Excel o CSV
// -----------------------------
app.post("/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;

  try {
    // Detectar extensión del archivo
    const ext = path.extname(req.file.originalname).toLowerCase();
    let data = [];

    if (ext === ".xls" || ext === ".xlsx") {
      // ✅ Leer Excel
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else if (ext === ".csv") {
      // ✅ Leer CSV
      const csv = require("csv-parser");
      const results = [];
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (row) => results.push(row))
          .on("end", () => resolve())
          .on("error", (err) => reject(err));
      });
      data = results;
    } else {
      throw new Error("Formato no soportado. Subí un archivo .xls, .xlsx o .csv");
    }

    fs.unlinkSync(filePath); // eliminar archivo temporal

    // -----------------------------
    // Procesamiento o actualización de los datos
    // -----------------------------
    const actualizados = data.map((item) => {
      // Ejemplo: actualizar campos "precio" y "fecha"
      const precio = parseFloat(item.precio) * 1.05 || 0; // +5% ejemplo
      const fecha = new Date().toISOString().split("T")[0]; // fecha actual
      return { ...item, precio, fecha };
    });

    // (opcional) Enviar a una API externa, por ejemplo:
    // await axios.post("https://api.tu-servidor.com/actualizar", actualizados);

    res.json({
      message: "Archivo procesado correctamente",
      filas: actualizados.length,
      muestra: actualizados.slice(0, 5),
    });
  } catch (error) {
    console.error("Error procesando archivo:", error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------
// Puerto dinámico (Render)
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
