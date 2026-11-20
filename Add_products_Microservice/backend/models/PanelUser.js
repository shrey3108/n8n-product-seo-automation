import mongoose from 'mongoose';

const panelUserSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  userId: String,
  adminId: String,
});

// Use the exact same collection as the main app
export default mongoose.model('admin-panel-user', panelUserSchema, 'admin-panel-users');
