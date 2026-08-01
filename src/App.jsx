import React from 'react';
import AuthGuard from './AuthGuard';
import SellerDoctorTool from './SellerDoctorTool';

export default function App() {
  return (
    <AuthGuard>
      <SellerDoctorTool />
    </AuthGuard>
  );
}
