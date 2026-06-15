import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api.js';
import InterviewCalendar from '../../components/InterviewCalendar.jsx';

export default function RecruiterCalendarPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/calendar/recruiter/${id}`).then((res) => setData(res.data));
  }, [id]);

  if (!data) return <p className="muted">Завантаження...</p>;

  return (
    <div>
      <Link to="/admin/calendar" className="muted">&larr; До загального календаря</Link>
      <h1>Календар: {data.recruiter.fullName}</h1>
      <InterviewCalendar events={data.events} />
    </div>
  );
}
