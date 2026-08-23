import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import SchoolPicker from './pages/SchoolPicker';
import Students from './pages/Students';
import StudentDetail from './pages/StudentDetail';
import Teachers from './pages/Teachers';
import TeacherDetail from './pages/TeacherDetail';
import Schedule from './pages/Schedule';
import Attendance from './pages/Attendance';
import Seats from './pages/Seats';
import Finance from './pages/Finance';
import Invoices from './pages/Invoices';
import InvoiceDetail from './pages/InvoiceDetail';
import Payslips from './pages/Payslips';
import PayslipDetail from './pages/PayslipDetail';
import Members from './pages/Members';
import Notes from './pages/Notes';
import Layout from './components/Layout';

function Gate() {
  const { user, loading, currentSchoolId } = useAuth();

  if (loading) return <p style={{ padding: 20 }}>載入中...</p>;
  if (!user) return <Login />;

  return (
    <Routes>
      <Route path="/schools" element={<SchoolPicker />} />
      {currentSchoolId ? (
        <Route element={<Layout />}>
          <Route path="/students" element={<Students />} />
          <Route path="/students/:id" element={<StudentDetail />} />
          <Route path="/teachers" element={<Teachers />} />
          <Route path="/teachers/:id" element={<TeacherDetail />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/seats" element={<Seats />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/payslips" element={<Payslips />} />
          <Route path="/payslips/:id" element={<PayslipDetail />} />
          <Route path="/members" element={<Members />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="*" element={<Navigate to="/students" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/schools" replace />} />
      )}
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
