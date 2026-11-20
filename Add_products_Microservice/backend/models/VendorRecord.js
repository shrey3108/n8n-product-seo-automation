import mongoose from 'mongoose';

const vendorRecordSchema = new mongoose.Schema({
  addedBy: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    default: '',
  },
  codePrefix: {
    type: String,
    default: '',
  },
  vendorDetails: {
    type: String,
    default: '',
  },
  vendorContact: {
    type: String,
    default: '',
  },

}, { timestamps: true });

const VendorRecord = mongoose.model('MicroserviceVendorRecord', vendorRecordSchema);
export default VendorRecord;
