const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const { month } = req.query;

    let startDate, endDate;
    if (month) {
      const [year, m] = month.split('-').map(Number);
      startDate = new Date(year, m - 1, 1);
      endDate = new Date(year, m, 0, 23, 59, 59, 999);
    }

    const summaryFilter = { user: req.user._id };
    if (startDate && endDate) {
      summaryFilter.date = { $gte: startDate, $lte: endDate };
    }

    const [summaryResult, monthlyData, recentTransactions] =
      await Promise.all([
        Transaction.aggregate([
          { $match: summaryFilter },
          {
            $group: {
              _id: null,
              totalIncome: {
                $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
              },
              totalExpense: {
                $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
              },
            },
          },
        ]),

        Transaction.aggregate([
          {
            $match: {
              user: req.user._id,
              date: {
                $gte: new Date(
                  new Date().getFullYear(),
                  new Date().getMonth() - 11,
                  1
                ),
              },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: '$date' },
                month: { $month: '$date' },
              },
              income: {
                $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
              },
              expense: {
                $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
              },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ]),

        Transaction.find({ user: req.user._id })
          .sort({ date: -1, createdAt: -1 })
          .limit(5),
      ]);

    const totals = summaryResult[0] || { totalIncome: 0, totalExpense: 0 };

    res.json({
      totalIncome: totals.totalIncome,
      totalExpense: totals.totalExpense,
      balance: totals.totalIncome - totals.totalExpense,
      monthlyData: monthlyData.map((r) => ({
        month: `${r._id.year}-${String(r._id.month).padStart(2, '0')}`,
        income: r.income,
        expense: r.expense,
      })),
      recentTransactions,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
