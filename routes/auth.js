const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── In-memory OTP store ──────────────────────────────────────────────
const otpStore = new Map(); // key: email -> { code, expiresAt, verified }

// ── Nodemailer transporter ───────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Twilio SMS client ────────────────────────────────────────────────
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const otpExpiryMinutes = 10;

// ── POST /api/auth/send-otp ──────────────────────────────────────────
router.post(
  '/send-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone')
      .optional({ values: 'falsy' })
      .matches(/^\+?[1-9]\d{6,14}$/)
      .withMessage('Valid phone number is required (format: +1234567890)'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, phone } = req.body;

      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(400).json({ message: 'Email already registered' });
      }

      // Generate ONE code for both channels
      const code = generateOtp();
      const expiresAt = Date.now() + otpExpiryMinutes * 60 * 1000;

      otpStore.set(email.toLowerCase(), { code, expiresAt, verified: false });

      // ── Send via email ──────────────────────────────────────────────
      if (transporter) {
        try {
          await transporter.sendMail({
            from: `"MoneyTracker" <${process.env.SMTP_USER}>`,
            to: email,
            subject: 'Your verification code',
            html: `<p>Your verification code is: <b>${code}</b></p>
                   <p>This code expires in ${otpExpiryMinutes} minutes.</p>`,
          });
        } catch (mailErr) {
          console.error('Failed to send email OTP:', mailErr.message);
        }
      }

      // ── Send via SMS ────────────────────────────────────────────────
      if (phone && twilioClient) {
        try {
          await twilioClient.messages.create({
            body: `Your MoneyTracker verification code is: ${code}. Expires in ${otpExpiryMinutes} minutes.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone.startsWith('+') ? phone : `+${phone}`,
          });
        } catch (smsErr) {
          console.error('Failed to send SMS OTP:', smsErr.message);
        }
      }

      // Always log to console for development
      console.log(
        `\n[DEV] OTP for ${email}${phone ? ` / ${phone}` : ''}: ${code} (expires in ${otpExpiryMinutes}min)\n`
      );

      const channels = [];
      if (transporter) channels.push('email');
      if (phone && twilioClient) channels.push('SMS');
      if (channels.length === 0) channels.push('console (dev mode)');

      res.json({
        message: `Verification code sent via ${channels.join(' & ')}.`,
        devCode: code,
      });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ── POST /api/auth/verify-otp ────────────────────────────────────────
router.post(
  '/verify-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('code').notEmpty().withMessage('Verification code is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, code } = req.body;
      const key = email.toLowerCase();
      const record = otpStore.get(key);

      if (!record) {
        return res.status(400).json({ message: 'No verification code sent to this email' });
      }

      if (Date.now() > record.expiresAt) {
        otpStore.delete(key);
        return res.status(400).json({ message: 'Verification code has expired. Request a new one.' });
      }

      if (record.code !== code) {
        return res.status(400).json({ message: 'Invalid verification code' });
      }

      record.verified = true;
      otpStore.set(key, record);

      res.json({ message: 'Email verified successfully' });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ── POST /api/auth/register ──────────────────────────────────────────
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password } = req.body;

      // ── Check OTP verification ──────────────────────────────────────
      const key = email.toLowerCase();
      const otpRecord = otpStore.get(key);
      if (!otpRecord || !otpRecord.verified) {
        return res.status(400).json({
          message: 'Email not verified. Please verify your email with the code sent to you.',
        });
      }

      const existing = await User.findOne({ email });
      if (existing) {
        return res.status(400).json({ message: 'Email already registered' });
      }

      // ── Create user ─────────────────────────────────────────────────
      const user = await User.create({
        name,
        email,
        password,
        authProvider: 'email',
      });

      otpStore.delete(key);

      const token = generateToken(user._id);

      res.status(201).json({ token, user });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ── POST /api/auth/login ─────────────────────────────────────────────
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;

      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ message: 'Invalid email or password' });
      }

      if (user.authProvider !== 'email') {
        return res.status(400).json({
          message: `This account uses ${user.authProvider} login. Please sign in with ${user.authProvider}.`,
        });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(400).json({ message: 'Invalid email or password' });
      }

      const token = generateToken(user._id);
      res.json({ token, user });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ── POST /api/auth/social ────────────────────────────────────────────
router.post(
  '/social',
  [
    body('authProvider')
      .isIn(['google', 'facebook'])
      .withMessage('Provider must be google or facebook'),
    body('accessToken').notEmpty().withMessage('Access token is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { authProvider, accessToken } = req.body;

      let email, name, providerId, avatar;

      // ── Verify Google ID token ──────────────────────────────────────
      if (authProvider === 'google') {
        try {
          const ticket = await googleClient.verifyIdToken({
            idToken: accessToken,
            audience: process.env.GOOGLE_CLIENT_ID,
          });
          const payload = ticket.getPayload();
          email = payload.email;
          name = payload.name;
          providerId = payload.sub;
          avatar = payload.picture;
        } catch (err) {
          return res.status(401).json({ message: 'Invalid Google token' });
        }
      }

      // ── Verify Facebook access token ────────────────────────────────
      if (authProvider === 'facebook') {
        const appId = process.env.FACEBOOK_APP_ID;
        const appSecret = process.env.FACEBOOK_APP_SECRET;

        const appSecretProof = crypto
          .createHmac('sha256', appSecret)
          .update(accessToken)
          .digest('hex');

        const fbUrl = `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}&appsecret_proof=${appSecretProof}`;

        try {
          const fbRes = await fetch(fbUrl);
          const fbData = await fbRes.json();

          if (fbData.error) {
            return res.status(401).json({ message: 'Invalid Facebook token' });
          }

          email = fbData.email;
          name = fbData.name;
          providerId = fbData.id;
          avatar = fbData.picture?.data?.url;
        } catch (err) {
          return res.status(401).json({ message: 'Failed to verify Facebook token' });
        }

        if (!email) {
          return res.status(400).json({
            message: 'Facebook email not available. Please ensure email permission is granted.',
          });
        }
      }

      if (!email || !name) {
        return res.status(400).json({ message: 'Could not retrieve user profile from provider' });
      }

      // ── Find or create user ─────────────────────────────────────────
      let user = await User.findOne({ email });

      if (user) {
        // ── Existing user: login without invite token ─────────────────
        if (user.authProvider !== authProvider) {
          return res.status(400).json({
            message: `This email is registered with ${user.authProvider}. Please use ${user.authProvider} to sign in.`,
          });
        }
        user.providerId = providerId;
        if (avatar) user.avatar = avatar;
        await user.save();
      } else {
        user = await User.create({
          name,
          email,
          authProvider,
          providerId,
          avatar,
        });
      }

      const token = generateToken(user._id);
      res.json({ token, user });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// ── GET /api/auth/me (protected) ─────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

// ── PUT /api/auth/profile (protected) ────────────────────────────────
router.put('/profile', auth, async (req, res) => {
  try {
    const { name, avatar, password, address, fatherName, contact, residence } = req.body;
    const user = req.user;

    if (name !== undefined) user.name = name.trim();
    if (avatar !== undefined) user.avatar = avatar;
    if (address !== undefined) user.address = address.trim();
    if (fatherName !== undefined) user.fatherName = fatherName.trim();
    if (contact !== undefined) user.contact = contact.trim();
    if (residence !== undefined) user.residence = residence.trim();
    if (password !== undefined && password.length >= 6) {
      user.password = password;
    }

    await user.save();
    res.json({ user: user.toJSON() });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
