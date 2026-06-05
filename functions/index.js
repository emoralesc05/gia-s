const functions = require("firebase-functions");
const admin = require("firebase-admin");
const twilio = require("twilio");

admin.initializeApp();
const db = admin.firestore();

// ── Credenciales Twilio desde variables de entorno ──
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ──────────────────────────────────────────────
// FUNCIÓN 1: Enviar mensaje al cliente cuando
// se crea un pedido nuevo en Firestore
// ──────────────────────────────────────────────
exports.enviarMensajePedido = functions.firestore
  .document("pedidos/{pedidoId}")
  .onCreate(async (snap, context) => {
    const pedido = snap.data();
    const pedidoId = context.params.pedidoId;

    // Solo procesar pedidos con WhatsApp
    if (pedido.tipoContacto !== "whatsapp") return null;

    const itemsTexto = pedido.items
      .map((i) => `• ${i.nombre} x${i.cantidad} — $${i.subtotal.toFixed(2)}`)
      .join("\n");

    const mensaje =
      `Hola ${pedido.cliente}! 👋 Recibimos tu pedido en Gia's.\n\n` +
      `*Tu pedido:*\n${itemsTexto}\n\n` +
      `*Total: $${pedido.total.toFixed(2)}*\n\n` +
      `¿Confirmas tu reserva?\n` +
      `Responde *SI* para confirmar\n` +
      `Responde *NO* para cancelar\n\n` +
      `_ID de pedido: ${pedidoId}_`;

    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${pedido.contacto.replace(/\D/g, "")}`,
        body: mensaje,
      });

      // Guardar el pedidoId asociado al número para identificarlo al responder
      await db.collection("sesiones_whatsapp").doc(
        pedido.contacto.replace(/\D/g, "")
      ).set({
        pedidoId: pedidoId,
        cliente: pedido.cliente,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Mensaje enviado a ${pedido.contacto}`);
    } catch (error) {
      console.error("Error enviando mensaje:", error);
    }

    return null;
  });

// ──────────────────────────────────────────────
// FUNCIÓN 2: Webhook que recibe la respuesta
// del cliente (SI / NO) desde Twilio
// ──────────────────────────────────────────────
exports.recibirRespuesta = functions.https.onRequest(async (req, res) => {
  const from = req.body.From || ""; // ej: whatsapp:+593999999999
  const body = (req.body.Body || "").trim().toUpperCase();
  const telefono = from.replace("whatsapp:+", "").replace(/\D/g, "");

  // Buscar el pedido asociado a este número
  const sesionDoc = await db.collection("sesiones_whatsapp").doc(telefono).get();

  if (!sesionDoc.exists) {
    // No hay pedido pendiente para este número
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: "No encontramos un pedido pendiente para este número. Visita nuestra página para hacer una reserva.",
    });
    res.sendStatus(200);
    return;
  }

  const { pedidoId, cliente } = sesionDoc.data();

  if (body === "SI" || body === "SÍ" || body === "S") {
    // Confirmar pedido
    await db.collection("pedidos").doc(pedidoId).update({
      estado: "confirmado",
      confirmadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });

    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Perfecto ${cliente}! Tu pedido ha sido *confirmado*. Pronto estará listo para que lo recojas. Gracias por elegir Gia's!`,
    });

    // Limpiar sesión
    await db.collection("sesiones_whatsapp").doc(telefono).delete();

  } else if (body === "NO" || body === "N") {
    // Cancelar pedido
    await db.collection("pedidos").doc(pedidoId).update({
      estado: "cancelado",
      canceladoEn: admin.firestore.FieldValue.serverTimestamp(),
    });

    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Entendido ${cliente}, tu pedido ha sido cancelado. Si cambias de opinión, puedes hacer una nueva reserva en cualquier momento.`,
    });

    // Limpiar sesión
    await db.collection("sesiones_whatsapp").doc(telefono).delete();

  } else {
    // Respuesta no reconocida
    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: `Por favor responde *SI* para confirmar tu pedido o *NO* para cancelarlo.`,
    });
  }

  res.sendStatus(200);
});
