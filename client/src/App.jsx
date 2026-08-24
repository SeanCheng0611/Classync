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
import TrashPage from './pages/TrashPage';
import Settings from './pages/Settings';
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
          <Route path="/students/trash" element={<TrashPage title="學生回收桶" entityTypes={['student', 'tuition_record']} />} />
          <Route path="/students/:id" element={<StudentDetail />} />
          <Route
            path="/students/:id/trash"
            element={<TrashPage title="這位學生的回收桶" entityTypes={['note', 'session', 'session_cancelled', 'tuition_record', 'invoice']} scope="student" />}
          />
          <Route path="/teachers" element={<Teachers />} />
          <Route path="/teachers/trash" element={<TrashPage title="教師回收桶" entityTypes={['teacher']} />} />
          <Route path="/teachers/:id" element={<TeacherDetail />} />
          <Route
            path="/teachers/:id/trash"
            element={<TrashPage title="這位教師的回收桶" entityTypes={['note', 'session', 'session_cancelled', 'schedule_template']} scope="teacher" />}
          />
          <Route path="/schedule" element={<Schedule />} />
          <Route
            path="/schedule/trash"
            element={<TrashPage title="課表回收桶" entityTypes={['session', 'session_cancelled', 'schedule_template']} />}
          />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/seats" element={<Seats />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/finance/trash" element={<TrashPage title="收支明細回收桶" entityTypes={['ledger_entry']} />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/invoices/trash" element={<TrashPage title="繳費單回收桶" entityTypes={['invoice']} />} />
          <Route path="/payslips" element={<Payslips />} />
          <Route path="/payslips/:id" element={<PayslipDetail />} />
          <Route path="/payslips/trash" element={<TrashPage title="薪資條回收桶" entityTypes={['payslip']} />} />
          <Route path="/members" element={<Members />} />
          <Route path="/members/trash" element={<TrashPage title="成員回收桶" entityTypes={['membership', 'invite_code']} />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/notes/trash" element={<TrashPage title="記事回收桶" entityTypes={['note']} />} />
          <Route path="/settings" element={<Settings />} />
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
