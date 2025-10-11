const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

const JUMPS_LOGIN = process.env.JUMPS_LOGIN;
const JUMPS_TOKEN = process.env.JUMPS_TOKEN;
const API_BASE = 'https://api.jumpseller.com/v1';

// 🔹 Función para formatear fecha a DD/MM/AA
function formatearFecha(fechaExcel) {
  if (!fechaExcel) return '';
  // Maneja tanto fecha tipo Excel como string
  if (fechaExcel instanceof Date) {
    const dia = String(fechaExcel.getDate()).padStart(2, '0');
    const mes = String(fechaExcel.getMonth() + 1).padStart(2, '0');
    const anio = String(fechaExcel.getFullYear()).slice(-2);
    return `${dia}/${mes}/${anio}`;
  }
  const partes = fechaExcel.toString().split(/[\/\-\.]/);
  if (partes.length >= 3) {
    const [d, m, a] = partes;
    const anio = a.length === 4 ? a.slice(-2) : a;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${anio}`;
  }
  return fechaExcel;
}

// 🔹 Leer archivo Excel
function leerExcel(path) {
  const workbook = XLSX.readFile(path);
  const sheetName = workbook.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  return data;
}

// 🔹 Obtener producto actual desde Jumpseller
async function obtenerProducto(sku) {
  try {
    const url = `${API_BASE}/products/search.json?query=${sku}`;
    const res = await axios.get(url, {
      auth: { username: JUMPS_LOGIN, password: JUMPS_TOKEN },
    });

    const productos = res.data.products || [];
    if (productos.length === 0) return null;

    const producto = productos[0].product || productos[0];

    const precioActual =
      producto.price ||
      (producto.variants?.[0]?.price ?? null);

    if (!precioActual) {
      console.log('⚠️ Producto sin precio detectado:', JSON.stringify(producto, null, 2));
    }

    return {
      id: producto.id,
      nombre: producto.name,
      precio: precioActual,
      stock: producto.stock || producto.variants?.[0]?.stock || '',
      sku: producto.sku || producto.variants?.[0]?.sku || sku
    };
  } catch (err) {
    console.error('❌ Error al obtener producto', sku, err.message);
    return null;
  }
}

// 🔹 Actualizar producto en Jumpseller
async function actualizarProducto(id, datos) {
  const url = `${API_BASE}/products/${id}.json`;
  try {
    const res = await axios.put(url, { product: datos }, {
      auth: { username: JUMPS_LOGIN, password: JUMPS_TOKEN },
      headers: { 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    console.error('❌ Error al actualizar producto', id, err.response?.data || err.message);
    return null;
  }
}

// 🔹 Endpoint principal
app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const data = leerExcel(filePath);
  fs.unlinkSync(filePath);

  const resultados = [];

  for (const fila of data) {
    const sku = fila.SKU || fila.sku;
    const nuevoPrecio = fila['Precio Nuevo'] || fila['precio nuevo'];
    const fechaOriginal = fila['Fecha'] || fila['fecha'];
    const fechaFormateada = formatearFecha(fechaOriginal);

    if (!sku || !nuevoPrecio) continue;

    const producto = await obtenerProducto(sku);
    if (!producto) continue;

    const updateData = {
      price: parseFloat(nuevoPrecio),
      custom_fields: [
        { name: 'Fecha', value: fechaFormateada }
      ]
    };

    const actualizado = await actualizarProducto(producto.id, updateData);

    resultados.push({
      SKU: sku,
      Nombre: producto.nombre,
      'Precio actual': producto.precio || '',
      'Precio nuevo': nuevoPrecio,
      Fecha: fechaFormateada,
      Resultado: actualizado ? '✅ Actualizado' : '❌ Error'
    });
  }

  res.json(resultados);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor activo en puerto ${PORT}`));
