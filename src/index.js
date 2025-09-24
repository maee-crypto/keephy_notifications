#!/usr/bin/env node

/**
 * Keephy Notifications Service
 * Manages notification rules, sending notifications, and notification history
 */

import express from 'express';
import mongoose from 'mongoose';
import pino from 'pino';
import pinoHttp from 'pino-http';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';

// Import models
import NotificationRule from './models/NotificationRule.js';
import Notification from './models/Notification.js';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const PORT = process.env.PORT || 3008;

// Middleware
app.use(helmet());
app.use(cors());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/keephy_enhanced';

mongoose.connect(MONGODB_URI)
  .then(() => logger.info('Connected to MongoDB'))
  .catch(err => logger.error('MongoDB connection error:', err));

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'keephy_notifications',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/ready', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ status: 'ready', service: 'keephy_notifications' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// =============================================================================
// NOTIFICATION RULE ROUTES
// =============================================================================

// Get notification rules by business
app.get('/api/businesses/:businessId/notification-rules', async (req, res) => {
  try {
    const { 
      franchiseId, 
      eventType, 
      isActive, 
      limit = 50, 
      offset = 0 
    } = req.query;
    
    let filter = { businessId: req.params.businessId };
    if (franchiseId) filter.franchiseId = franchiseId;
    if (eventType) filter.eventType = eventType;
    if (isActive !== undefined) filter['settings.isActive'] = isActive === 'true';
    
    const rules = await NotificationRule.find(filter)
      .populate('franchiseId', 'name')
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .sort({ 'settings.priority': -1, createdAt: -1 });
    
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (error) {
    logger.error('Error fetching notification rules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notification rules'
    });
  }
});

// Create notification rule
app.post('/api/notification-rules', async (req, res) => {
  try {
    const rule = new NotificationRule(req.body);
    await rule.save();
    
    res.status(201).json({
      success: true,
      data: rule
    });
  } catch (error) {
    logger.error('Error creating notification rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create notification rule'
    });
  }
});

// Update notification rule
app.put('/api/notification-rules/:id', async (req, res) => {
  try {
    const rule = await NotificationRule.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Notification rule not found'
      });
    }
    
    res.json({
      success: true,
      data: rule
    });
  } catch (error) {
    logger.error('Error updating notification rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notification rule'
    });
  }
});

// =============================================================================
// NOTIFICATION ROUTES
// =============================================================================

// Get notifications by business
app.get('/api/businesses/:businessId/notifications', async (req, res) => {
  try {
    const { 
      franchiseId, 
      eventType, 
      status, 
      priority,
      startDate,
      endDate,
      limit = 50, 
      offset = 0 
    } = req.query;
    
    let filter = { businessId: req.params.businessId };
    if (franchiseId) filter.franchiseId = franchiseId;
    if (eventType) filter.eventType = eventType;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (startDate && endDate) {
      filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    
    const notifications = await Notification.find(filter)
      .populate('ruleId', 'name eventType')
      .populate('franchiseId', 'name')
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: notifications,
      count: notifications.length
    });
  } catch (error) {
    logger.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
  }
});

// Trigger notification (for testing)
app.post('/api/notifications/trigger', async (req, res) => {
  try {
    const { businessId, eventType, triggerData } = req.body;
    
    // Find matching rules
    const rules = await NotificationRule.find({
      businessId,
      eventType,
      'settings.isActive': true
    });
    
    const triggeredNotifications = [];
    
    for (const rule of rules) {
      if (rule.shouldTrigger(triggerData)) {
        const notification = new Notification({
          ruleId: rule._id,
          businessId: rule.businessId,
          franchiseId: rule.franchiseId,
          eventType: rule.eventType,
          triggerData,
          recipients: rule.actions.flatMap(action => 
            action.recipients.map(recipient => ({
              type: recipient.type,
              value: recipient.value,
              status: 'pending'
            }))
          ),
          content: {
            subject: rule.actions[0]?.template || 'Notification',
            body: rule.actions[0]?.template || 'You have a new notification',
            template: rule.actions[0]?.template || 'default',
            variables: triggerData
          },
          priority: rule.actions[0]?.settings?.priority || 'normal',
          scheduledFor: new Date(Date.now() + (rule.actions[0]?.settings?.delay || 0) * 60000)
        });
        
        await notification.save();
        triggeredNotifications.push(notification);
        
        // Update rule statistics
        await rule.updateStatistics(true);
      }
    }
    
    res.json({
      success: true,
      data: triggeredNotifications,
      count: triggeredNotifications.length
    });
  } catch (error) {
    logger.error('Error triggering notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger notifications'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Keephy Notifications Service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  mongoose.connection.close();
  process.exit(0);
});
