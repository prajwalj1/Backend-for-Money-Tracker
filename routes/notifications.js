const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Budget = require('../models/Budget');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/settings', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notificationSettings');
    res.json(
      user.notificationSettings || {
        budgetAlerts: true,
        dailyReminder: false,
        reminderTime: '20:00',
        monthlyReport: true,
      }
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/settings', auth, async (req, res) => {
  try {
    const { budgetAlerts, dailyReminder, reminderTime, monthlyReport } = req.body;

    const user = await User.findById(req.user._id);
    if (!user.notificationSettings) {
      user.notificationSettings = {};
    }

    if (budgetAlerts !== undefined) user.notificationSettings.budgetAlerts = budgetAlerts;
    if (dailyReminder !== undefined) user.notificationSettings.dailyReminder = dailyReminder;
    if (reminderTime !== undefined) user.notificationSettings.reminderTime = reminderTime;
    if (monthlyReport !== undefined) user.notificationSettings.monthlyReport = monthlyReport;

    await user.save();
    res.json(user.notificationSettings);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/check-budget', auth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const budgets = await Budget.find({ user: req.user._id, period: 'monthly' });

    const alerts = [];

    for (const budget of budgets) {
      const matchFilter = {
        user: req.user._id,
        type: 'expense',
        date: { $gte: startOfMonth, $lte: endOfMonth },
      };

      if (budget.category) {
        matchFilter.category = budget.category;
      }

      const result = await Transaction.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);

      const spent = result[0]?.total || 0;
      const percentage = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;

      if (percentage >= 80) {
        alerts.push({
          budgetId: budget._id,
          category: budget.category,
          budgeted: budget.amount,
          spent,
          percentage: Math.round(percentage * 100) / 100,
          message:
            percentage >= 100
              ? `Budget exceeded! Spent ${spent.toFixed(2)} of ${budget.amount.toFixed(2)}`
              : `Budget limit nearing: ${percentage.toFixed(0)}% used (${spent.toFixed(2)} of ${budget.amount.toFixed(2)})`,
        });
      }
    }

    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
