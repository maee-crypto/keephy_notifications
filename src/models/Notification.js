/**
 * Notification Model
 * Represents individual notification instances
 */

import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  ruleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'NotificationRule',
    required: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  franchiseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Franchise',
    default: null
  },
  eventType: {
    type: String,
    enum: ['form_submitted', 'rating_low', 'rating_high', 'complaint', 'compliment', 'staff_mentioned', 'custom'],
    required: true
  },
  triggerData: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  recipients: [{
    type: {
      type: String,
      enum: ['email', 'phone', 'slack_user', 'webhook_url'],
      required: true
    },
    value: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'delivered', 'bounced'],
      default: 'pending'
    },
    sentAt: {
      type: Date,
      default: null
    },
    error: {
      type: String,
      default: null
    },
    retryCount: {
      type: Number,
      default: 0
    }
  }],
  content: {
    subject: String,
    body: String,
    template: String,
    variables: mongoose.Schema.Types.Mixed
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'],
    default: 'pending'
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  scheduledFor: {
    type: Date,
    default: Date.now
  },
  sentAt: {
    type: Date,
    default: null
  },
  failedAt: {
    type: Date,
    default: null
  },
  error: {
    type: String,
    default: null
  },
  retryCount: {
    type: Number,
    default: 0
  },
  maxRetries: {
    type: Number,
    default: 3
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    source: String,
    tags: [String]
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
notificationSchema.index({ ruleId: 1 });
notificationSchema.index({ businessId: 1 });
notificationSchema.index({ franchiseId: 1 });
notificationSchema.index({ eventType: 1 });
notificationSchema.index({ status: 1 });
notificationSchema.index({ priority: 1 });
notificationSchema.index({ scheduledFor: 1 });
notificationSchema.index({ createdAt: -1 });

// Pre-save middleware
notificationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
notificationSchema.methods.markAsSent = function() {
  this.status = 'sent';
  this.sentAt = new Date();
  this.recipients.forEach(recipient => {
    if (recipient.status === 'pending') {
      recipient.status = 'sent';
      recipient.sentAt = new Date();
    }
  });
  return this.save();
};

notificationSchema.methods.markAsFailed = function(error) {
  this.status = 'failed';
  this.failedAt = new Date();
  this.error = error;
  this.recipients.forEach(recipient => {
    if (recipient.status === 'pending') {
      recipient.status = 'failed';
      recipient.error = error;
    }
  });
  return this.save();
};

notificationSchema.methods.incrementRetry = function() {
  this.retryCount += 1;
  this.recipients.forEach(recipient => {
    if (recipient.status === 'failed') {
      recipient.retryCount += 1;
    }
  });
  return this.save();
};

notificationSchema.methods.canRetry = function() {
  return this.retryCount < this.maxRetries && this.status === 'failed';
};

notificationSchema.methods.getSuccessRate = function() {
  const totalRecipients = this.recipients.length;
  if (totalRecipients === 0) return 0;
  
  const successfulRecipients = this.recipients.filter(r => 
    ['sent', 'delivered'].includes(r.status)
  ).length;
  
  return (successfulRecipients / totalRecipients) * 100;
};

// Static methods
notificationSchema.statics.getPendingNotifications = function(limit = 100) {
  return this.find({
    status: 'pending',
    scheduledFor: { $lte: new Date() }
  })
  .populate('ruleId')
  .sort({ priority: -1, scheduledFor: 1 })
  .limit(limit);
};

notificationSchema.statics.getFailedNotifications = function(limit = 100) {
  return this.find({
    status: 'failed',
    retryCount: { $lt: 3 }
  })
  .populate('ruleId')
  .sort({ failedAt: 1 })
  .limit(limit);
};

notificationSchema.statics.getNotificationStats = function(businessId, startDate, endDate) {
  const match = { businessId };
  if (startDate && endDate) {
    match.createdAt = { $gte: startDate, $lte: endDate };
  }
  
  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalRecipients: { $sum: { $size: '$recipients' } },
        successfulRecipients: {
          $sum: {
            $size: {
              $filter: {
                input: '$recipients',
                cond: { $in: ['$$this.status', ['sent', 'delivered']] }
              }
            }
          }
        }
      }
    }
  ]);
};

export default mongoose.model('Notification', notificationSchema);
