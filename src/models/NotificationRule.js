/**
 * Notification Rule Model
 * Defines when and how notifications should be sent
 */

import mongoose from 'mongoose';

const conditionSchema = new mongoose.Schema({
  field: {
    type: String,
    required: true
  },
  operator: {
    type: String,
    enum: ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'not_contains', 'in', 'not_in'],
    required: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
});

const actionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['email', 'sms', 'slack', 'webhook', 'push'],
    required: true
  },
  template: {
    type: String,
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
    }
  }],
  settings: {
    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal'
    },
    delay: {
      type: Number,
      default: 0 // minutes
    },
    retryAttempts: {
      type: Number,
      default: 3
    },
    retryDelay: {
      type: Number,
      default: 5 // minutes
    }
  }
});

const notificationRuleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    maxlength: 500
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
  conditions: [conditionSchema],
  actions: [actionSchema],
  settings: {
    isActive: {
      type: Boolean,
      default: true
    },
    priority: {
      type: Number,
      default: 0
    },
    cooldown: {
      type: Number,
      default: 0 // minutes between notifications
    },
    timeWindow: {
      start: String, // HH:MM format
      end: String,   // HH:MM format
      timezone: {
        type: String,
        default: 'UTC'
      }
    },
    frequency: {
      type: String,
      enum: ['immediate', 'hourly', 'daily', 'weekly'],
      default: 'immediate'
    }
  },
  statistics: {
    totalTriggered: {
      type: Number,
      default: 0
    },
    totalSent: {
      type: Number,
      default: 0
    },
    totalFailed: {
      type: Number,
      default: 0
    },
    lastTriggered: {
      type: Date,
      default: null
    }
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
notificationRuleSchema.index({ businessId: 1 });
notificationRuleSchema.index({ franchiseId: 1 });
notificationRuleSchema.index({ eventType: 1 });
notificationRuleSchema.index({ 'settings.isActive': 1 });
notificationRuleSchema.index({ 'settings.priority': -1 });

// Pre-save middleware
notificationRuleSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Methods
notificationRuleSchema.methods.evaluateConditions = function(data) {
  return this.conditions.every(condition => {
    const fieldValue = this.getNestedValue(data, condition.field);
    
    switch (condition.operator) {
      case 'equals':
        return fieldValue === condition.value;
      case 'not_equals':
        return fieldValue !== condition.value;
      case 'greater_than':
        return Number(fieldValue) > Number(condition.value);
      case 'less_than':
        return Number(fieldValue) < Number(condition.value);
      case 'contains':
        return String(fieldValue).toLowerCase().includes(String(condition.value).toLowerCase());
      case 'not_contains':
        return !String(fieldValue).toLowerCase().includes(String(condition.value).toLowerCase());
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
      default:
        return false;
    }
  });
};

notificationRuleSchema.methods.getNestedValue = function(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
};

notificationRuleSchema.methods.isInTimeWindow = function() {
  if (!this.settings.timeWindow.start || !this.settings.timeWindow.end) {
    return true;
  }
  
  const now = new Date();
  const timezone = this.settings.timeWindow.timezone || 'UTC';
  
  // Convert to timezone
  const localTime = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const currentTime = localTime.getHours() * 60 + localTime.getMinutes();
  
  const startTime = this.parseTime(this.settings.timeWindow.start);
  const endTime = this.parseTime(this.settings.timeWindow.end);
  
  if (startTime <= endTime) {
    return currentTime >= startTime && currentTime <= endTime;
  } else {
    // Handle overnight time windows
    return currentTime >= startTime || currentTime <= endTime;
  }
};

notificationRuleSchema.methods.parseTime = function(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours * 60 + minutes;
};

notificationRuleSchema.methods.shouldTrigger = function(data) {
  // Check if rule is active
  if (!this.settings.isActive) {
    return false;
  }
  
  // Check time window
  if (!this.isInTimeWindow()) {
    return false;
  }
  
  // Check cooldown
  if (this.settings.cooldown > 0 && this.statistics.lastTriggered) {
    const cooldownMs = this.settings.cooldown * 60 * 1000;
    const timeSinceLastTrigger = Date.now() - this.statistics.lastTriggered.getTime();
    if (timeSinceLastTrigger < cooldownMs) {
      return false;
    }
  }
  
  // Evaluate conditions
  return this.evaluateConditions(data);
};

notificationRuleSchema.methods.updateStatistics = function(success) {
  this.statistics.totalTriggered += 1;
  this.statistics.lastTriggered = new Date();
  
  if (success) {
    this.statistics.totalSent += 1;
  } else {
    this.statistics.totalFailed += 1;
  }
  
  return this.save();
};

export default mongoose.model('NotificationRule', notificationRuleSchema);
