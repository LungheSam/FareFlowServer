const express = require('express');
const cors = require('cors');
const africastalking = require('africastalking');
const emailjs = require('@emailjs/nodejs');
const sgMail = require('@sendgrid/mail');
const mqtt = require('mqtt');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, arrayUnion, collection } = require('firebase/firestore');
const { getDatabase, ref, get: getRTDB } = require('firebase/database'); // Ensure you import RTDB functions
const { get, set, remove } = require('firebase/database');


require('dotenv').config();


const app = express();
const PORT = 5000;
const MIN_BALANCE = 1000;
const RATE_PER_KM=500;
const busPlateNumber = 'UAZ-123'; // Make this dynamic later
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  databaseURL: process.env.FIREBASE_DATABASE_URL
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const dbRT = getDatabase(firebaseApp); // RTDB instance
// Middleware
app.use(cors());
app.use(express.json());

// EmailJS setup
emailjs.init({
  publicKey: process.env.EMAILJS_PUBLIC_KEY,
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
});
//SendGrid Setup
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// Africa's Talking setup
const at = africastalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME,
});
const sms = at.SMS;

function haversineDistance(lat1, lon1, lat2, lon2) {
  function toRad(x) {
    return x * Math.PI / 180;
  }

  const R = 6371; // Radius of Earth in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in kilometers
}

async function processFare(user, fareAmount) {
  const userRef = doc(db, 'users', user.cardUID); // or however you're getting the UID
  const transactionRecord = {
    amount: fareAmount,
    date: new Date().toISOString(),
    type: 'payment'
  };

  await updateDoc(userRef, {
    balance: user.balance - fareAmount,
    transactions: arrayUnion(transactionRecord)
  });

  await addDoc(collection(db, 'transactions'), {
    amount: fareAmount,
    busId: 'Bus 1',
    busPlateNumber: user.busPlateNumber || 'UNKNOWN',
    cardUID: user.cardUID,
    passengerName: `${user.firstName} ${user.lastName || ''}`.trim(),
    timestamp: new Date()
  });
  const busRef = doc(db, 'buses', busPlateNumber);
  const busSnap = await getDoc(busRef);

    if (busSnap.exists()) {
      const busData = busSnap.data();
      const today = new Date();
      const dayStr = today.toISOString().split('T')[0]; // e.g., "2025-05-26"
      const monthStr = today.toLocaleString('default', { month: 'short' }); // e.g., "May"

      // Weekly earnings
      let weeklyEarnings = [...(busData.weeklyEarnings || [])];
      const weeklyIndex = weeklyEarnings.findIndex(entry => entry.day === dayStr);
      if (weeklyIndex >= 0) {
        weeklyEarnings[weeklyIndex].amount += fareAmount;
      } else {
        weeklyEarnings.push({ day: dayStr, amount: fareAmount });
      }

      // Monthly earnings
      let monthlyEarnings = [...(busData.monthlyEarnings || [])];
      const monthlyIndex = monthlyEarnings.findIndex(entry => entry.month === monthStr);
      if (monthlyIndex >= 0) {
        monthlyEarnings[monthlyIndex].amount += fareAmount;
      } else {
        monthlyEarnings.push({ month: monthStr, amount: fareAmount });
      }

      // Total earnings
      const totalEarnings = (busData.totalEarnings || 0) + fareAmount;

      await updateDoc(busRef, {
        weeklyEarnings,
        monthlyEarnings,
        totalEarnings
      });
    }
}
















// MQTT Setup
const mqttRequestTopic = 'fareflow/buses/UAZ-123/request';
const mqttResponseTopic = 'fareflow/buses/UAZ-123/fareResponse';
const client = mqtt.connect('mqtt://test.mosquitto.org');

client.on('connect', () => {
  console.log('✅ MQTT connected');
  client.subscribe(mqttRequestTopic, () => {
    console.log(`📡 Subscribed to ${mqttRequestTopic}`);
  });
});

client.on('message', async (topic, message) => {
  if (topic === mqttRequestTopic) {
    try {
      const { cardUID } = JSON.parse(message.toString());
      console.log('Card:', cardUID);
      await processFareRequest(cardUID, 'UAZ-123');
    } catch (err) {
      console.error('Error handling MQTT request:', err);
    }
  }
});

// Core Fare Logic
async function processFareRequest(cardUID, busPlateNumber) {
  try {
    // const MIN_BALANCE = 500;
    // const RATE_PER_KM = 800;

    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      const result = {
        status: 'error',
        message: 'User not found',
        hardwareCode: 'USER_NOT_FOUND'
      };

      return publishFareResponse(busPlateNumber, cardUID, result);
    }

    const user = userSnap.data();

    if (user.blocked) {
      const result = {
        status: 'error',
        message: 'User Blocked',
        hardwareCode: 'USER_BLOCKED'
      };

      return publishFareResponse(busPlateNumber, cardUID, result);
    }

    const busRTRef = ref(dbRT, `buses/${busPlateNumber}`);
    const busRTSnap = await get(busRTRef);

    if (!busRTSnap.exists()) {
      const result = {
        status: 'error',
        message: 'Bus not found in RTDB',
        hardwareCode: 'BUS_NOT_FOUND'
      };

      return publishFareResponse(busPlateNumber, cardUID, result);
    }

    const busRTData = busRTSnap.val();

    if (!busRTData.status) {
      const result = {
        status: 'inactive',
        message: 'Bus is currently inactive',
        hardwareCode: 'BUS_INACTIVE'
      };

      return publishFareResponse(busPlateNumber, cardUID, result);
    }


    if (user.balance < MIN_BALANCE) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nDue to Low balance.\nMinimum required for every trip: ${MIN_BALANCE} UGX,\nPlease Load Money in your Card: ${cardUID}.\nThank you for using FareFlow`,
        hardwareCode: 'LOW_BALANCE'
      };
      publishFareResponse(busPlateNumber, cardUID, result);
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(process.env.EMAILJS_SERVICE_ID, process.env.EMAILJS_TEMPLATE_PAYMENT_ID, {
        first_name: user.firstName,
        transaction_id: `${cardUID}-${Date.now()}`,
        transaction_date: new Date().toLocaleString(),
        card_uid: cardUID,
        previous_balance: user.balance,
        email: user.email,
        status_title: 'Payment Failed',
        status_message: `Unfortunately, your fare payment could not be processed. Low balance. Minimum required: ${MIN_BALANCE} UGX.\nPlease ensure you have sufficient balance or contact support.`
      });
      return ;
    }

    const route = busRTData.route;
    if (route?.type === 'dynamic') {
      const busRef = ref(dbRT, `buses/${busPlateNumber}`);
      const passengersRef = ref(dbRT, `buses/${busPlateNumber}/passengers`);
      const passengerRef = ref(dbRT, `buses/${busPlateNumber}/passengers/${cardUID}`);

      // --- Ensure passengers node is an object
      const busSnap = await get(busRef);
      const busData = busSnap.val() || {};
  
      if (typeof busData.passengers === 'string') {
        // Fix incorrect data type
        await set(passengersRef, {});
      }

      const passengerSnap = await get(passengerRef);

      // === START TRIP ===
      if (!passengerSnap.exists()) {
        const locationSnap = await get(ref(dbRT, `buses/${busPlateNumber}/location`));
        const location = locationSnap.val() || {};

        const { latitude, longitude } = location;
        const result={
          status: 'info',
          message: 'Welcome aboard. Dynamic pricing in effect.',
          hardwareCode: 'DYNAMIC_ROUTE_WELCOME_TO_BUS'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        publishFareResponse(busPlateNumber, cardUID, result);
        if (latitude === undefined || longitude === undefined) {
          const result={
            status: 'error',
            message: 'Bus location not available. Try again shortly.',
            hardwareCode: 'LOCATION_UNAVAILABLE'
          }
          // await writeFareResponseToRTDB(busPlateNumber, result);
          publishFareResponse(busPlateNumber, cardUID, result);
          return;
        }

        const passengerData = {
          name: `${user.firstName} ${user.lastName || ''}`.trim(),
          cardUID,
          startTime: Date.now(),
          startLat: latitude,
          startLon: longitude
        };

        await set(passengerRef, passengerData);
        await updateDoc(doc(db, 'users', cardUID), { onTrip: true });

        // publishFareResponse(busPlateNumber, cardUID, result);

        const smsMessage = `You have started a trip from ${route.departure}.\nBus: ${busPlateNumber}\nDynamic pricing is active.\nPlease tap your card again when you stop at destination.\nService fee: 500UGX`;
        await sms.send({ to: [user.phone], message: smsMessage });

        await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_ID,
          {
            first_name: user.firstName,
            trip_start_time: new Date().toLocaleString(),
            route_start: route.departure,
            email: user.email,
            message:smsMessage
          }
        );

    return; // Early exit
      }

      // === END TRIP ===
      const startData = passengerSnap.val();
      const { startLat, startLon } = startData;

      const locationSnap = await get(ref(dbRT, `buses/${busPlateNumber}/location`));
      const location = locationSnap.val() || {};
      const { latitude: currentLat, longitude: currentLon } = location;

      if (
        startLat === undefined || startLon === undefined ||
        currentLat === undefined || currentLon === undefined
      ) {
        const result={
          status: 'error',
          message: 'Missing location data to complete trip.',
          hardwareCode: 'INCOMPLETE_TRIP_LOCATION'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        publishFareResponse(busPlateNumber, cardUID, result);
        return;
      }

      const distanceKm = haversineDistance(startLat, startLon, currentLat, currentLon);
      const fareAmount = distanceKm * RATE_PER_KM;

      if (fareAmount > user.balance) {
        // Notify driver
        await set(ref(dbRT, `buses/${busPlateNumber}/notifications/${Date.now()}`), {
          type: 'low_balance',
          cardUID,
          message: 'Passenger balance too low. Trip ended.'
        });

        await processFare(user, user.balance);
        await updateDoc(doc(db, 'users', cardUID), { onTrip: false });
        await remove(passengerRef);
        const result={
          status: 'error',
          message: 'Trip ended: Insufficient balance.',
          hardwareCode: 'TRIP_ENDED_LOW_BALANCE'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        publishFareResponse(busPlateNumber, cardUID, result);

        return;
      }
      const result={
        status: 'success',
        // message: `Trip complete. Fare: ${fareAmount.toFixed(0)} UGX`,
        message: `Trip complete.`,
        amount: String(fareAmount.toFixed(0)),
        hardwareCode: 'TRIP_COMPLETE'
      }
      // await writeFareResponseToRTDB(busPlateNumber, result);
      // Normal trip end
      publishFareResponse(busPlateNumber, cardUID, result);

      setImmediate(async () => {
          try {
            await processFare(user, fareAmount);
            await updateDoc(doc(db, 'users', cardUID), { onTrip: false });
            await remove(passengerRef);

            const smsMessage = `FareFlow Trip complete.\nFare: ${fareAmount.toFixed(0)} UGX\nDistance: ${distanceKm.toFixed(2)} km\nThank you for using riding with us,\nThank you for using FareFlow`;
            await sms.send({ to: [user.phone], message: smsMessage });

            await emailjs.send(
              process.env.EMAILJS_SERVICE_ID,
              process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
              {
                first_name: user.firstName,
                transaction_id: `${cardUID}-${Date.now()}`,
                transaction_date: new Date().toLocaleString(),
                card_uid: cardUID,
                fare_amount: fareAmount.toFixed(0),
                previous_balance: user.balance,
                current_balance: user.balance - fareAmount,
                email: user.email,
                status_title: 'Trip Complete',
                status_message: 'Thank you for riding. Payment processed.'
              }
            );
          }catch (err) {
            console.error('Post-processing error:', err);
          }
    });

      return;
    }
    const FARE_AMOUNT = route?.fareAmount || 2000;

    if (user.balance < FARE_AMOUNT) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nInsufficient balance for the fare. Needed: ${FARE_AMOUNT} UGX\nThank you for using FareFlow`,
        hardwareCode: 'INSUFFICIENT_FARE'
      };
      publishFareResponse(busPlateNumber, cardUID, result);
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(process.env.EMAILJS_SERVICE_ID, process.env.EMAILJS_TEMPLATE_PAYMENT_ID, {
        first_name: user.firstName,
        transaction_id: `${cardUID}-${Date.now()}`,
        transaction_date: new Date().toLocaleString(),
        card_uid: cardUID,
        fare_amount: FARE_AMOUNT,
        previous_balance: user.balance,
        current_balance: user.balance,
        email: user.email,
        status_title: 'Payment Failed',
        status_message: `Unfortunately, your fare payment could not be processed. Insufficient balance for the fare. Needed: ${FARE_AMOUNT} UGX.\nPlease ensure you have sufficient balance or contact support.`
      });
      return ;
    }

    const newBalance = user.balance - FARE_AMOUNT;

    const successResponse = {
      status: 'success',
      message: 'Fare processed successfully',
      newBalance,
      hardwareCode: 'PAYMENT_SUCCESS'
    };

    publishFareResponse(busPlateNumber, cardUID, successResponse);

    // Async post-processing
    setImmediate(async () => {
      try {
        await updateDoc(userRef, {
          balance: newBalance,
          transactions: arrayUnion({
            amount: FARE_AMOUNT,
            date: new Date().toISOString(),
            type: 'payment'
          })
        });

        await addDoc(collection(db, 'transactions'), {
          amount: FARE_AMOUNT,
          busId: 'Bus 1',
          busPlateNumber,
          cardUID,
          passengerName: `${user.firstName} ${user.lastName || ''}`.trim(),
          timestamp: new Date()
        });

        const busDocRef = doc(db, 'buses', busPlateNumber);
        const busDocSnap = await getDoc(busDocRef);
        if (busDocSnap.exists()) {
          const busData = busDocSnap.data();
          const today = new Date();
          const dayStr = today.toISOString().split('T')[0];
          const monthStr = today.toLocaleString('default', { month: 'short' });

          let weeklyEarnings = [...(busData.weeklyEarnings || [])];
          const weeklyIndex = weeklyEarnings.findIndex(e => e.day === dayStr);
          if (weeklyIndex >= 0) weeklyEarnings[weeklyIndex].amount += FARE_AMOUNT;
          else weeklyEarnings.push({ day: dayStr, amount: FARE_AMOUNT });

          let monthlyEarnings = [...(busData.monthlyEarnings || [])];
          const monthlyIndex = monthlyEarnings.findIndex(e => e.month === monthStr);
          if (monthlyIndex >= 0) monthlyEarnings[monthlyIndex].amount += FARE_AMOUNT;
          else monthlyEarnings.push({ month: monthStr, amount: FARE_AMOUNT });

          const totalEarnings = (busData.totalEarnings || 0) + FARE_AMOUNT;

          await updateDoc(busDocRef, {
            weeklyEarnings,
            monthlyEarnings,
            totalEarnings
          });
        }

        const passengerRef = ref(dbRT, `buses/${busPlateNumber}/passengers/${cardUID}`);
        const passengerSnap = await get(passengerRef);
        if (!passengerSnap.exists()) {
          await set(passengerRef, {
            name: `${user.firstName} ${user.lastName || ''}`.trim(),
            cardUID,
            timestamp: Date.now()
          });
        }

        const smsMessage = `FareFlow Payment Successful\n\nA fare of ${FARE_AMOUNT} UGX has been deducted from your account\nRoute: ${route.departure} to ${route.destination}\nYour new balance is ${newBalance} UGX.\n\nThank you for riding with us.`;
        await sms.send({ to: [user.phone], message: smsMessage });

        await emailjs.send(process.env.EMAILJS_SERVICE_ID, process.env.EMAILJS_TEMPLATE_PAYMENT_ID, {
          first_name: user.firstName,
          transaction_id: `${cardUID}-${Date.now()}`,
          transaction_date: new Date().toLocaleString(),
          card_uid: cardUID,
          fare_amount: FARE_AMOUNT,
          previous_balance: user.balance,
          current_balance: newBalance,
          email: user.email,
          status_title: 'Success',
          status_message: 'Your fare payment has been processed successfully.'
        });

      } catch (postErr) {
        console.error('Post-processing error:', postErr);
      }
    });

  } catch (err) {
    console.error('Processing fare error:', err);
    publishFareResponse(busPlateNumber, cardUID, {
      status: 'error',
      message: 'Internal server error',
      hardwareCode: 'SERVER_ERROR'
    });
  }
}

// Publish response back to MQTT
function publishFareResponse(busPlateNumber, cardUID, result) {
  console.log(result);
  const response = {
    cardUID,
    timestamp: Date.now(),
    ...result
  };

  client.publish(mqttResponseTopic, JSON.stringify(response));
}

















































































// Welcome Message Endpoint
app.post('/send-welcome-message', async (req, res) => {
  const { email, phone, firstName, lastName, cardUID, password } = req.body;
  const message = `Hello ${firstName},\nThank you for registering on FareFlow.\nEmail: ${email}\nCardUID: ${cardUID}\nPassword: ${password}\nGo to https://fare-flow-user.vercel.app/  \nDo not share your credentials given above with anyone\n`;

  try {
    // Send Email using EmailJS
    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      {
        to_email: email,
        subject: 'Welcome to FareFlow',
        message: message,
        email: email,
        first_name: firstName,
        card_uid: cardUID,
        password: password
      }
    );
    console.log("Email Sent Successfully to "+email);

    // Send SMS using Africa's Talking
    const result = await sms.send({
      to: [phone],
      message: message,
    });
    console.log('SMS sent:', result);
    res.status(200).json({ success: true, message: 'Registration successful! Email and SMS sent.' });

  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/send-welcome-message-driver', async (req, res) => {
  const { email, phone, firstName, licenseNumber, password } = req.body;

  const message = `Hello Driver ${firstName},\nThank you for registering on FareFlow as Driver.\n----------------\nEmail: ${email}\nPassword: ${password}\nGo to https://fare-flow-driver.vercel.app/ and login with the credentials given.\nDo not share your credentials with anyone....\n`;

  try {
    // Send Email using SendGrid
    const msg = {
      to: email,
      from: 'ishigamisenku0504@gmail.com', // Use your verified sender
      subject: 'Welcome to FareFlow',
      text: message,
      templateId: process.env.SENDGRID_DRIVER_TEMPLATE_ID, // Set this in your .env
      dynamic_template_data: {
        first_name: firstName,
        email: email,
        password: password,
      }
    };

    await sgMail.send(msg).then((response) => {
    console.log(response[0].statusCode)
    console.log(response[0].headers)
  })
  .catch((error) => {
    console.error(error)
  });
    console.log("Email Sent Successfully to " + email);

    // Send SMS using Africa's Talking
    const result = await sms.send({
      to: [phone],
      message: message,
    });
    console.log('SMS sent:', result);

    res.status(200).json({ success: true, message: 'Registration successful! Email and SMS sent.' });

  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/process-fare', async (req, res) => {
  console.log(String(req.method)+ " - " +String(req.url));
  const { cardUID } = req.body;

  try {
    // 1. Find user by card UID
    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      const result = {
          status: 'error',
          message: 'User not found',
          hardwareCode: 'USER_NOT_FOUND'
        };
        // await writeFareResponseToRTDB(busPlateNumber, result);
        return res.status(200).json(result);

    }

    const user = userSnap.data();
    if (user.blocked) {
      const result = {
          status: 'error',
          message: 'User Blocked',
          hardwareCode: 'USER_BLOCKED'
        };
        // await writeFareResponseToRTDB(busPlateNumber, result);
        return res.status(200).json(result);
    }

    // 2. Get Bus Info from RTDB
    
    const busRTRef = ref(dbRT, `buses/${busPlateNumber}`);
    const busRTSnap = await getRTDB(busRTRef);

    if (!busRTSnap.exists()) {
      const result = {
        status: 'error',
        message: 'Bus not found in RTDB',
        hardwareCode: 'BUS_NOT_FOUND'
      };
        // await writeFareResponseToRTDB(busPlateNumber, result);
        return res.status(200).json(result);
    }

    const busRTData = busRTSnap.val();

    if (!busRTData.status) {
      const result = {
        status: 'inactive',
        message: 'Bus is currently inactive',
        hardwareCode: 'BUS_INACTIVE'
      };
        // await writeFareResponseToRTDB(busPlateNumber, result);
        return res.status(200).json(result);
    }

    // Proceed with fixed route fare deduction
    if (user.balance < MIN_BALANCE) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nDue to Low balance.\nMinimum required for every trip: ${MIN_BALANCE} UGX,\nPlease Load Money in your Card: ${cardUID}.\nThank you for using FareFlow`,
        hardwareCode: 'LOW_BALANCE'
      };
      // await writeFareResponseToRTDB(busPlateNumber, result);
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
            {
              first_name: user.firstName,
              transaction_id: `${cardUID}-${Date.now()}`,
              transaction_date: new Date().toLocaleString(),
              card_uid: cardUID,
              // fare_amount: FARE_AMOUNT,
              previous_balance: user.balance,
              // current_balance: newBalance,
              email: user.email,
              status_title:'Payment Failed',
              status_message:'Unfortunately, your fare payment could not be processed. Low balance. Minimum required: '+{MIN_BALANCE}+'UGX\nPlease ensure you have sufficient balance or contact support.'
            }
        );
      return res.status(200).json(result);
    }
    const route = busRTData.route;
    if (route?.type === 'dynamic') {
      const busRef = ref(dbRT, `buses/${busPlateNumber}`);
      const passengersRef = ref(dbRT, `buses/${busPlateNumber}/passengers`);
      const passengerRef = ref(dbRT, `buses/${busPlateNumber}/passengers/${cardUID}`);

      // --- Ensure passengers node is an object
      const busSnap = await get(busRef);
      const busData = busSnap.val() || {};
  
      if (typeof busData.passengers === 'string') {
        // Fix incorrect data type
        await set(passengersRef, {});
      }

      const passengerSnap = await get(passengerRef);

      // === START TRIP ===
      if (!passengerSnap.exists()) {
        const locationSnap = await get(ref(dbRT, `buses/${busPlateNumber}/location`));
        const location = locationSnap.val() || {};

        const { latitude, longitude } = location;
        const result={
          status: 'info',
          message: 'Welcome aboard. Dynamic pricing in effect.',
          hardwareCode: 'DYNAMIC_ROUTE_WELCOME_TO_BUS'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        if (latitude === undefined || longitude === undefined) {
          const result={
            status: 'error',
            message: 'Bus location not available. Try again shortly.',
            hardwareCode: 'LOCATION_UNAVAILABLE'
          }
          // await writeFareResponseToRTDB(busPlateNumber, result);
          return res.json(result);
        }

        const passengerData = {
          name: `${user.firstName} ${user.lastName || ''}`.trim(),
          cardUID,
          startTime: Date.now(),
          startLat: latitude,
          startLon: longitude
        };

        await set(passengerRef, passengerData);
        await updateDoc(doc(db, 'users', cardUID), { onTrip: true });

        res.json(result);

        const smsMessage = `You have started a trip from ${route.departure}.\nBus: ${busPlateNumber}\nDynamic pricing is active.\nPlease tap your card again when you stop at destination.\nService fee: 500UGX`;
        await sms.send({ to: [user.phone], message: smsMessage });

        await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_ID,
          {
            first_name: user.firstName,
            trip_start_time: new Date().toLocaleString(),
            route_start: route.departure,
            email: user.email,
            message:smsMessage
          }
        );

    return; // Early exit
      }

      // === END TRIP ===
      const startData = passengerSnap.val();
      const { startLat, startLon } = startData;

      const locationSnap = await get(ref(dbRT, `buses/${busPlateNumber}/location`));
      const location = locationSnap.val() || {};
      const { latitude: currentLat, longitude: currentLon } = location;

      if (
        startLat === undefined || startLon === undefined ||
        currentLat === undefined || currentLon === undefined
      ) {
        const result={
          status: 'error',
          message: 'Missing location data to complete trip.',
          hardwareCode: 'INCOMPLETE_TRIP_LOCATION'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        return res.json(result);
      }

      const distanceKm = haversineDistance(startLat, startLon, currentLat, currentLon);
      const fareAmount = distanceKm * RATE_PER_KM;

      if (fareAmount > user.balance) {
        // Notify driver
        await set(ref(dbRT, `buses/${busPlateNumber}/notifications/${Date.now()}`), {
          type: 'low_balance',
          cardUID,
          message: 'Passenger balance too low. Trip ended.'
        });

        await processFare(user, user.balance);
        await updateDoc(doc(db, 'users', cardUID), { onTrip: false });
        await remove(passengerRef);
        const result={
          status: 'error',
          message: 'Trip ended: Insufficient balance.',
          hardwareCode: 'TRIP_ENDED_LOW_BALANCE'
        }
        // await writeFareResponseToRTDB(busPlateNumber, result);
        res.json(result);

        return;
      }
      const result={
        status: 'success',
        // message: `Trip complete. Fare: ${fareAmount.toFixed(0)} UGX`,
        message: `Trip complete.`,
        hardwareCode: 'TRIP_COMPLETE'
      }
      // await writeFareResponseToRTDB(busPlateNumber, result);
      // Normal trip end
      res.json(result);
      setImmediate(async () => {
          try {
            await processFare(user, fareAmount);
            await updateDoc(doc(db, 'users', cardUID), { onTrip: false });
            await remove(passengerRef);

            const smsMessage = `FareFlow Trip complete.\nFare: ${fareAmount.toFixed(0)} UGX\nDistance: ${distanceKm.toFixed(2)} km\nThank you for using riding with us,\nThank you for using FareFlow`;
            await sms.send({ to: [user.phone], message: smsMessage });

            await emailjs.send(
              process.env.EMAILJS_SERVICE_ID,
              process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
              {
                first_name: user.firstName,
                transaction_id: `${cardUID}-${Date.now()}`,
                transaction_date: new Date().toLocaleString(),
                card_uid: cardUID,
                fare_amount: fareAmount.toFixed(0),
                previous_balance: user.balance,
                current_balance: user.balance - fareAmount,
                email: user.email,
                status_title: 'Trip Complete',
                status_message: 'Thank you for riding. Payment processed.'
              }
            );
          }catch (err) {
            console.error('Post-processing error:', err);
          }
    });




      return;
    }




    //Fixed Route Type Payment
    const FARE_AMOUNT = route.fareAmount || 2000;
    if (user.balance < FARE_AMOUNT) {
      const result = {
        status: 'error',
        message: `FareFlow Payment Unsuccessful\nInsufficient balance for the fare. Needed: ${FARE_AMOUNT} UGX\nThank you for using FareFlow`,
        hardwareCode: 'INSUFFICIENT_FARE'
      };
      // await writeFareResponseToRTDB(busPlateNumber, result);
      await sms.send({ to: [user.phone], message: result.message });
      await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
          {
            first_name: user.firstName,
            transaction_id: `${cardUID}-${Date.now()}`,
            transaction_date: new Date().toLocaleString(),
            card_uid: cardUID,
            fare_amount: FARE_AMOUNT,
            previous_balance: user.balance,
            current_balance: user.balance,
            email: user.email,
            status_title:'Payment Failed',
            status_message:'Unfortunately, your fare payment could not be processed. Insufficient balance for the fare. Needed:'+{FARE_AMOUNT}+'UGX.\nPlease ensure you have sufficient balance or contact support.'
          }
        );
      return res.status(200).json(result);
    }
    const newBalance = user.balance - FARE_AMOUNT;
    // Respond immediately to the hardware
    // await writeFareResponseToRTDB(busPlateNumber, {
    //   status: 'success',
    //   message: 'Fare processed successfully',
    //   newBalance,
    //   hardwareCode: 'PAYMENT_SUCCESS'
    // });
    res.json({
      status: 'success',
      message: 'Fare processed successfully',
      newBalance,
      hardwareCode: 'PAYMENT_SUCCESS'
    });
  
    // Begin async post-processing
    setImmediate(async () => {
      try {
        // Record transaction in the global transactions collection
        
        const transactionRecord = {
          amount: FARE_AMOUNT,
          date: new Date().toISOString(),
          type: 'payment'
        };

        // Update user balance and transaction history
        await updateDoc(userRef, {
          balance: newBalance,
          transactions: arrayUnion(transactionRecord)
        });
        await addDoc(collection(db, 'transactions'), {
          amount: FARE_AMOUNT,
          busId: 'Bus 1',
          busPlateNumber,
          cardUID,
          passengerName: `${user.firstName} ${user.lastName || ''}`.trim(),
          timestamp: new Date()
        });

        // Update bus earnings
        const busRef = doc(db, 'buses', busPlateNumber);
        const busSnap = await getDoc(busRef);

        if (busSnap.exists()) {
          const busData = busSnap.data();
          const today = new Date();
          const dayStr = today.toISOString().split('T')[0]; // e.g., "2025-05-26"
          const monthStr = today.toLocaleString('default', { month: 'short' }); // e.g., "May"

          // Weekly earnings
          let weeklyEarnings = [...(busData.weeklyEarnings || [])];
          const weeklyIndex = weeklyEarnings.findIndex(entry => entry.day === dayStr);
          if (weeklyIndex >= 0) {
            weeklyEarnings[weeklyIndex].amount += FARE_AMOUNT;
          } else {
            weeklyEarnings.push({ day: dayStr, amount: FARE_AMOUNT });
          }

          // Monthly earnings
          let monthlyEarnings = [...(busData.monthlyEarnings || [])];
          const monthlyIndex = monthlyEarnings.findIndex(entry => entry.month === monthStr);
          if (monthlyIndex >= 0) {
            monthlyEarnings[monthlyIndex].amount += FARE_AMOUNT;
          } else {
            monthlyEarnings.push({ month: monthStr, amount: FARE_AMOUNT });
          }

          // Total earnings
          const totalEarnings = (busData.totalEarnings || 0) + FARE_AMOUNT;

          await updateDoc(busRef, {
            weeklyEarnings,
            monthlyEarnings,
            totalEarnings
          });
        }
        // Add passenger to RTDB if not already there
      const passengerRefFixed = ref(dbRT, `buses/${busPlateNumber}/passengers/${cardUID}`);
      const passengerSnapFixed = await get(passengerRefFixed);

      if (!passengerSnapFixed.exists()) {
        await set(passengerRefFixed, {
          name: `${user.firstName} ${user.lastName || ''}`.trim(),
          cardUID,
          timestamp: Date.now()
        });
      }

        // Send SMS receipt
        const smsMessage = `FareFlow Payment Successful\n\nA fare of ${FARE_AMOUNT} UGX has been deducted from your account\nRoute: ${busRTData.route.departure} to ${busRTData.route.destination}\nYour new balance is ${newBalance} UGX.\n\nThank you for riding with us.\nThank you for using FareFlow`;
        await sms.send({ to: [user.phone], message: smsMessage });

        // Send email receipt
        await emailjs.send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
          {
            first_name: user.firstName,
            transaction_id: `${cardUID}-${Date.now()}`,
            transaction_date: new Date().toLocaleString(),
            card_uid: cardUID,
            fare_amount: FARE_AMOUNT,
            previous_balance: user.balance,
            current_balance: newBalance,
            email: user.email,
            status_title: 'Success',
            status_message: 'Your fare payment has been processed successfully.'
          }
        );

      } catch (err) {
        console.error('Post-processing error:', err);
        // Optionally log to monitoring service (e.g. Sentry, LogRocket)
      }
    });


  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      hardwareCode: 'SERVER_ERROR'
    });
  }
});


app.post('/notify-balance-load', async (req, res) => {
  console.log(String(req.method)+ " - " +String(req.url));
  const { cardUID, amount, newBalance, email, phone, firstName } = req.body;

  try {
    const transactionId = `${cardUID}-${Date.now()}`;

    //1. Send SMS
    await sms.send({
      to: [phone],
      message: `\n------\nFareFlow TopUp Successful\n------\nHello ${firstName}, Your FareFlow account ${cardUID} has been topped up with ${amount} UGX.\nNew Balance: ${newBalance} UGX.\nThank you for using FareFlow...`
    });

    // 2. Send Email
    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_PAYMENT_ID,
      {
        transaction_id: transactionId,
        transaction_date: new Date().toLocaleString(),
        card_uid: cardUID,
        amount,
        current_balance: newBalance,
        email,
        first_name: firstName,
        status_title: 'Balance Top-Up Successful',
        status_message: `You have successfully added ${amount} UGX to your FareFlow account.\nThank you for using FareFlow....`
      }
    );

    res.json({ status: 'success', message: 'Notifications sent' });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to send notifications' });
  }
});
// Get User Balance Endpoint
app.get('/user-balance/:cardUID', async (req, res) => {
  console.log(String(req.method)+ " - " +String(req.url));
  try {
    const userRef = doc(db, 'users', req.params.cardUID);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ balance: userSnap.data().balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Add Funds Endpoint
app.post('/add-funds', async (req, res) => {
  console.log(String(req.method)+ " - " +String(req.url));
  const { cardUID, amount } = req.body;
  
  try {
    const userRef = doc(db, 'users', cardUID);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData=userSnap.data();
    const currentBalance = userSnap.data().balance;
    const newBalance = currentBalance + Number(amount);
    
    await updateDoc(userRef, {
      balance: newBalance
    });
    
    res.json({ 
      message: `Successfully added ${amount} UGX to account ${cardUID}\nNew Balance: ${newBalance}`,
      newBalance: newBalance 
    });
    await fetch('https://fareflowserver-production.up.railway.app/notify-balance-load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardUID,
          amount,
          newBalance,
          email: userData.email,
          phone: userData.phone,
          firstName: userData.firstName,
        })
      });
  
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});