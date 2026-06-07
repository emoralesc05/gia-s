const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio — inicializar primero para detectar error rapido
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "";

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("Faltan variables de entorno de Twilio");
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Firebase Admin
let serviceAccount;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
  serviceAccount = JSON.parse(raw);
} catch(e) {
  console.error("Error parseando FIREBASE_SERVICE_ACCOUNT:", e.message);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ──────────────────────────────────────────────
// POST /nuevo-pedido
// La web llama a este endpoint cuando llega un pedido nuevo
// ──────────────────────────────────────────────
app.post("/nuevo-pedido", async (req, res) => {
  const { pedidoId, cliente, contacto, items, total } = req.body;

  const itemsTexto = items
    .map((i) => `• ${i.nombre} x${i.cantidad} — $${parseFloat(i.subtotal).toFixed(2)}`)
    .join("\n");

  const mensaje =
    `Hola ${cliente}! Recibimos tu pedido en Gia's.\n\n` +
    `*Tu pedido:*\n${itemsTexto}\n\n` +
    `*Total: $${parseFloat(total).toFixed(2)}*\n\n` +
    `Confirmas tu reserva?\n` +
    `Responde *SI* para confirmar\n` +
    `Responde *NO* para cancelar\n\n` +
    `_ID: ${pedidoId}_`;

  try {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${contacto.replace(/\D/g, "")}`,
      body: mensaje,
    });

    await db.collection("sesiones_whatsapp")
      .doc(contacto.replace(/\D/g, ""))
      .set({
        pedidoId,
        cliente,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ──────────────────────────────────────────────
// POST /respuesta-whatsapp
// Twilio llama aqui cuando el cliente responde SI o NO
// ──────────────────────────────────────────────
app.post("/respuesta-whatsapp", async (req, res) => {
  const from = req.body.From || "";
  const body = (req.body.Body || "").trim().toUpperCase();
  const telefono = from.replace("whatsapp:+", "").replace(/\D/g, "");

  const sesionDoc = await db.collection("sesiones_whatsapp").doc(telefono).get();

  if (!sesionDoc.exists) {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: "No encontramos un pedido pendiente. Visita nuestra pagina para hacer una reserva.",
    });
    res.sendStatus(200);
    return;
  }

  const { pedidoId, cliente } = sesionDoc.data();

  if (body === "SI" || body === "SÍ" || body === "S") {
    await db.collection("pedidos").doc(pedidoId).update({
      estado: "confirmado",
      confirmadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Perfecto ${cliente}! Tu pedido ha sido *confirmado*. Pronto estara listo. Gracias por elegir Gia's!`,
    });
    await db.collection("sesiones_whatsapp").doc(telefono).delete();

  } else if (body === "NO" || body === "N") {
    await db.collection("pedidos").doc(pedidoId).update({
      estado: "cancelado",
      canceladoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Entendido ${cliente}, tu pedido ha sido cancelado. Puedes hacer una nueva reserva cuando quieras.`,
    });
    await db.collection("sesiones_whatsapp").doc(telefono).delete();

  } else {
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Por favor responde *SI* para confirmar tu pedido o *NO* para cancelarlo.`,
    });
  }

  res.sendStatus(200);
});

// Health check
app.get("/", (req, res) => res.send("Gia's backend activo"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
