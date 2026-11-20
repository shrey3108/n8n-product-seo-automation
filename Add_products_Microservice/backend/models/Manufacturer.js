import mongoose from 'mongoose';

const manufacturerSchema = new mongoose.Schema({
  manufacturerId: { type: String, required: true, unique: true },
  manufacturerName: { type: String, required: true, unique: true },
});

export default mongoose.model("manufacturer-communets", manufacturerSchema);
