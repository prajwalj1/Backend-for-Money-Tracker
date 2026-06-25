const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    minlength: 6,
  },
  authProvider: {
    type: String,
    enum: ['email', 'google', 'facebook'],
    default: 'email',
  },
  providerId: {
    type: String,
  },
  notificationSettings: {
    budgetAlerts: { type: Boolean, default: true },
    dailyReminder: { type: Boolean, default: false },
    reminderTime: { type: String, default: '20:00' },
    monthlyReport: { type: Boolean, default: true },
  },
  avatar: {
    type: String,
  },
  address: {
    type: String,
    trim: true,
  },
  fatherName: {
    type: String,
    trim: true,
  },
  contact: {
    type: String,
    trim: true,
  },
  residence: {
    type: String,
    trim: true,
  },
  balance: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
