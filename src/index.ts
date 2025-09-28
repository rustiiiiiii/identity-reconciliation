import express from 'express';
import identifyRoutes from './routes/identifyRoutes.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

app.use('/', identifyRoutes);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});