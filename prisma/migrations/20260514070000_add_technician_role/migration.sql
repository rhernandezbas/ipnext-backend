-- Add 'technician' value to AdminRole enum so field technicians can be modeled separately from engineers
ALTER TYPE "AdminRole" ADD VALUE 'technician';
