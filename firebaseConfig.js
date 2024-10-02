const { initializeApp } = require("firebase/app");
const { getStorage } = require("firebase/storage");
const { getFirestore } = require("firebase/firestore");

const firebaseConfig = {
    apiKey: "AIzaSyC3UYvFTEkK5mcpiaj-OBScBknf0tZ9eNA",
    authDomain: "mawjradio.firebaseapp.com",
    projectId: "mawjradio",
    storageBucket: "mawjradio.appspot.com",
    messagingSenderId: "115460395954",
    appId: "1:115460395954:web:36eb71036948d93f8dcaab"
};

const app = initializeApp(firebaseConfig);

const storage = getStorage(app);
const db = getFirestore(app);

module.exports = { storage, db };
