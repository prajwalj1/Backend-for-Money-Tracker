const express = require('express');
const auth = require('../middleware/auth');
const Budget = require('../models/Budget');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const budgets = await Budget.find({ user: req.user._id }).sort({ category: 1 });
    res.json(budgets);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { category, amount, period } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Valid budget amount is required' });
    }
    const budget = await Budget.create({
      user: req.user._id,
      category: category || undefined,
      amount,
      period: period || 'monthly',
    });
    res.status(201).json(budget);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { category, amount, period } = req.body;
    const budget = await Budget.findOne({ _id: req.params.id, user: req.user._id });
    if (!budget) return res.status(404).json({ message: 'Budget not found' });
    if (amount !== undefined) budget.amount = amount;
    if (category !== undefined) budget.category = category || undefined;
    if (period !== undefined) budget.period = period;
    await budget.save();
    res.json(budget);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const budget = await Budget.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!budget) return res.status(404).json({ message: 'Budget not found' });
    res.json({ message: 'Budget deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const budgets = await Budget.find({ user: req.user._id, period: 'monthly' });
    const statuses = [];

    for (const budget of budgets) {
      const matchFilter = {
        user: req.user._id,
        type: 'expense',
        date: { $gte: startOfMonth, $lte: endOfMonth },
      };
      if (budget.category) matchFilter.category = budget.category;

      const result = await Transaction.aggregate([
        { $match: matchFilter },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);

      const spent = result[0]?.total || 0;
      const remaining = budget.amount - spent;
      const percentage = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;

      statuses.push({
        _id: budget._id,
        category: budget.category,
        amount: budget.amount,
        period: budget.period,
        spent,
        remaining: Math.max(0, remaining),
        percentage: Math.round(percentage * 100) / 100,
        exceeded: spent > budget.amount,
      });
    }

    res.json(statuses);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/category-breakdown', auth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const result = await Transaction.aggregate([
      {
        $match: {
          user: req.user._id,
          type: 'expense',
          date: { $gte: startOfMonth, $lte: endOfMonth },
        },
      },
      {
        $group: {
          _id: '$category',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]);

    res.json(result.map((r) => ({
      category: r._id || 'Other',
      total: r.total,
      count: r.count,
    })));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
