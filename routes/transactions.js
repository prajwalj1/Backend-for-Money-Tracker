const express = require('express');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const {
      type,
      startDate,
      endDate,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = { user: req.user._id };

    if (type) filter.type = type;

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    if (search) {
      filter.note = { $regex: search, $options: 'i' };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      transactions,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/summary', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const filter = { user: req.user._id };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    const result = await Transaction.aggregate([
      { $match: filter },
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
    ]);

    const totals = result[0] || { totalIncome: 0, totalExpense: 0 };
    res.json({
      totalIncome: totals.totalIncome,
      totalExpense: totals.totalExpense,
      balance: totals.totalIncome - totals.totalExpense,
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/monthly-summary', auth, async (req, res) => {
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const result = await Transaction.aggregate([
      {
        $match: {
          user: req.user._id,
          date: { $gte: twelveMonthsAgo },
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
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    res.json(
      result.map((r) => ({
        year: r._id.year,
        month: r._id.month,
        income: r.income,
        expense: r.expense,
        count: r.count,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/daily-summary', auth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const startDate = req.query.startDate ? new Date(req.query.startDate) : startOfMonth;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : endOfMonth;

    const result = await Transaction.aggregate([
      {
        $match: {
          user: req.user._id,
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$date' },
          },
          income: {
            $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
          },
          expense: {
            $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json(
      result.map((r) => ({
        date: r._id,
        income: r.income,
        expense: r.expense,
        count: r.count,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { type, amount, note, date } = req.body;

    if (!type || !amount) {
      return res.status(400).json({ message: 'Type and amount are required' });
    }

    const transaction = await Transaction.create({
      user: req.user._id,
      type,
      amount,
      note: note || '',
      date: date || new Date(),
    });

    res.status(201).json(transaction);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const { type, amount, note, date } = req.body;
    if (type !== undefined) transaction.type = type;
    if (amount !== undefined) transaction.amount = amount;
    if (note !== undefined) transaction.note = note;
    if (date !== undefined) transaction.date = date;

    await transaction.save();
    res.json(transaction);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const transaction = await Transaction.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    res.json({ message: 'Transaction deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
