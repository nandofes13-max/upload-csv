// -----------------------------
// upload-server.js
// -----------------------------

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Configuración de Multer (para subir archivos CSV)
// -----------------------------
const upload = multer({ dest: "uploads/" });

// -----------------------------
// Ruta principal de prueba
// -----------------------------
app.get("/", (req, res) => {
  res.send("🚀 Servidor funcionando correctamente en Render");
});

// -----------------------------
// Ruta para subir y procesar CSV
// -----------------------------
app.post("/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const results = [];

  try {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", async () => {
        fs.unlinkSync(filePath); // elimina el archivo temporal

        // Ejemplo: envío de datos a una API externa si lo necesitás
        /*
        await axios.post("https://tu-api.com/procesar", results);
        */

        res.json({
          message: "Archivo CSV procesado correctamente",
          rows: results.length,
          sample: results.slice(0, 5) // muestra primeras filas
        });
      });
  } catch (error) {
    console.error("Error procesando CSV:", error);
    res.status(500).json({ error: "Error al procesar el archivo CSV" });
  }
});

// -----------------------------
// Puerto dinámico para Render
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
