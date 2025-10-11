import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import XLSX from "xlsx";
import axios from "axios";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// Función para formatear fecha DD/MM/AA
function formatearFecha(fechaExcel) {
  if (!fechaExcel) return "";
  const partes = fechaExcel.toString().split(/[\/\-\.]/);
  if (partes.length === 3) {
    const [dia, mes, anio] = partes;
    const anio2 = anio.length === 4 ? anio.slice(-2) : anio;
    return `${dia.padStart(2, "0")}/${mes.padStart(2, "0")}/${anio2}`;
  }
  return fechaExcel;
}

// Ruta para procesar el archivo Excel
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    let productos = [];

    // Leer por posiciones de columna fijas: A=COD.INT, F=PRECIO, M=FECHA
    for (let row = 2; row <= range.e.r + 1; row++) {
      const codInt = sheet[`A${row}`]?.v?.toString().trim();
      const precio = sheet[`F${row}`]?.v?.toString().trim();
      const fecha = sheet[`M${row}`]?.v?.toString().trim();
      if (codInt && precio) {
        productos.push({
          codInt,
          precio,
          fecha: formatearFecha(fecha)
        });
      }
    }

    fs.unlinkSync(filePath); // eliminar archivo temporal

    if (!productos.length) {
      console.log("⚠️ No se encontraron filas válidas en el Excel.");
      return res.status(400).json({ error: "No se encontraron productos válidos en el archivo." });
    }

    // Consultar productos actuales en Jumpseller
    const login = process.env.JUMPS_LOGIN;
    const token = process.env.JUMPS_TOKEN;

    const productosConInfo = [];

    for (const item of productos) {
      try {
        const resp = await axios.get(`https://api.jumpseller.com/v1/products/search.json?sku=${item.codInt}`, {
          auth: { username: login, password: token }
        });

        const producto = resp.data.products?.[0]?.product || resp.data.product;
        const precioActual = producto?.price || producto?.variants?.[0]?.price || "";

        productosConInfo.push({
          sku: item.codInt,
          nombre: producto?.name || "No encontrado",
          precioActual,
          nuevoPrecio: item.precio,
          fechaNueva: item.fecha
        });
      } catch (err) {
        console.error(`❌ Error buscando SKU ${item.codInt}:`, err.response?.data || err.message);
      }
    }

    res.json({ productos: productosConInfo });
  } catch (err) {
    console.error("❌ Error procesando archivo:", err);
    res.status(500).json({ error: "Error procesando archivo." });
  }
});

// Ruta para confirmar actualización
app.post("/actualizar", async (req, res) => {
  try {
    const { productos } = req.body;
    const login = process.env.JUMPS_LOGIN;
    const token = process.env.JUMPS_TOKEN;

    for (const p of productos) {
      try {
        const resp = await axios.get(`https://api.jumpseller.com/v1/products/search.json?sku=${p.sku}`, {
          auth: { username: login, password: token }
        });
        const producto = resp.data.products?.[0]?.product;
        if (!producto) continue;

        const productId = producto.id;

        await axios.put(
          `https://api.jumpseller.com/v1/products/${productId}.json`,
          {
            product: {
              price: p.nuevoPrecio,
              custom_fields: [
                { name: "Fecha", value: p.fechaNueva }
              ]
            }
          },
          { auth: { username: login, password: token } }
        );

        console.log(`✅ Actualizado ${p.sku} con precio ${p.nuevoPrecio} y fecha ${p.fechaNueva}`);
      } catch (err) {
        console.error(`❌ Error actualizando ${p.sku}:`, err.response?.data || err.message);
      }
    }

    res.json({ mensaje: "Actualización completada correctamente." });
  } catch (err) {
    console.error("❌ Error general:", err);
    res.status(500).json({ error: "Error durante la actualización." });
  }
});

// Ruta raíz
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor escuchando en el puerto ${PORT}`));
